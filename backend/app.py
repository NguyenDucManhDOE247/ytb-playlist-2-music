from flask import Flask, request, jsonify, Response, stream_with_context
import yt_dlp
import os
import tempfile
import time
import glob
import requests
import traceback
import re
import sys
import signal
import atexit
import shutil
from concurrent.futures import ThreadPoolExecutor
import hashlib
import uuid
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# Global variable to track temporary directories in use
active_temp_dirs = set()

def add_temp_dir(temp_dir):
    """Add temp dir to tracking list"""
    active_temp_dirs.add(temp_dir)

def remove_temp_dir(temp_dir):
    """Remove temp dir from tracking list"""
    if temp_dir in active_temp_dirs:
        active_temp_dirs.remove(temp_dir)

def cleanup_all_temp_dirs():
    """Clean up all tracked temporary directories"""
    print("[Flask] Cleaning up all temporary directories before shutdown...")
    for temp_dir in list(active_temp_dirs):
        try:
            if os.path.exists(temp_dir):
                print(f"[Flask] Removing: {temp_dir}")
                shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception as e:
            print(f"[Flask] Error removing {temp_dir}: {e}")
    
    active_temp_dirs.clear()

# Register cleanup function to be called when program exits
atexit.register(cleanup_all_temp_dirs)

# Catch system signals to clean up before exiting
def signal_handler(sig, frame):
    print(f"\n[Flask] Received signal {sig}, cleaning up...")
    cleanup_all_temp_dirs()
    sys.exit(0)

signal.signal(signal.SIGINT, signal_handler)  # Ctrl+C
signal.signal(signal.SIGTERM, signal_handler)  # kill

# Set encoding for stdout to handle Unicode characters
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

app = Flask(__name__)

# Enable CORS
from flask_cors import CORS
CORS(app)

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://",
)

def sanitize_filename(filename):
    """Process filenames to avoid special characters"""
    # Replace Vietnamese characters with non-accented equivalents
    vietnamese_chars = {
        'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
        'ă': 'a', 'ắ': 'a', 'ằ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
        'â': 'a', 'ấ': 'a', 'ầ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
        'đ': 'd',
        'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
        'ê': 'e', 'ế': 'e', 'ề': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
        'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
        'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
        'ô': 'o', 'ố': 'o', 'ồ': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
        'ơ': 'o', 'ớ': 'o', 'ờ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
        'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
        'ư': 'u', 'ứ': 'u', 'ừ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
        'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
    }
    
    for vi_char, en_char in vietnamese_chars.items():
        filename = filename.replace(vi_char, en_char)
        filename = filename.replace(vi_char.upper(), en_char.upper())
    
    # Replace unwanted characters with underscores
    filename = re.sub(r'[^\w\s.-]', '_', filename)
    # Replace spaces with underscores
    filename = re.sub(r'\s+', '_', filename)
    # Reduce multiple consecutive underscores to one
    filename = re.sub(r'_+', '_', filename)
    
    return filename

# Cache video info to reduce YouTube API calls
video_info_cache = {}
CACHE_DURATION = 3600  # 1 hour

def get_video_info(video_id):
    cache_key = video_id
    now = time.time()
    
    if cache_key in video_info_cache and now - video_info_cache[cache_key]['timestamp'] < CACHE_DURATION:
        print(f"[Flask] Using cached info for video {video_id}")
        return video_info_cache[cache_key]['info']
    
    print(f"[Flask] Fetching fresh info for video {video_id}")
    with yt_dlp.YoutubeDL({'quiet': True}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        video_info_cache[cache_key] = {
            'info': info,
            'timestamp': now
        }
        return info

@app.route("/download", methods=['GET'])
@limiter.limit("3/minute")
def download_audio():
    t_start = time.time()  # Start timer for whole request
    video_id = request.args.get('videoId')

    if not video_id:
        return jsonify({"error": "Missing videoId parameter"}), 400

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    print(f"[Flask] Received request for videoId: {video_id}")

    try:
        # Create a temporary file name for the downloaded audio
        temp_dir = tempfile.mkdtemp()
        # Track temp directory for cleanup if needed
        add_temp_dir(temp_dir)
        print(f"[Flask] Created temp directory at {temp_dir}")
        
        # yt-dlp options with MP3 conversion at 320kbps
        ydl_opts = {
            'format': 'bestaudio',
            'postprocessors': [{
                'key': 'FFmpegExtractAudio',
                'preferredcodec': 'mp3',
                'preferredquality': '320',
            }],
            'outtmpl': f'{temp_dir}/%(title)s.%(ext)s',  # Control output filename 
            'quiet': True,
        }

        try:
            print(f"[Flask] Downloading and converting {video_url}")
            t_before_download = time.time()
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Extract info first to get video title
                info_dict = ydl.extract_info(video_url, download=False)
                # Process video name to avoid encoding errors
                title = info_dict.get('title', 'audio')
                sanitized_title = sanitize_filename(title)
                
                print(f"[Flask] Video title: {sanitized_title}")
                
                # Download and automatically convert to MP3
                ydl.download([video_url])
                
                # Find the downloaded file
                mp3_files = glob.glob(f"{temp_dir}/*.mp3")
                
                # Safely print files (handle special characters)
                try:
                    print(f"[Flask] Found MP3 files: {[os.path.basename(f) for f in mp3_files]}")
                except:
                    print(f"[Flask] Found {len(mp3_files)} MP3 files (names contain special characters)")
                
                if not mp3_files:
                    raise Exception(f"Could not find downloaded MP3 file in {temp_dir}")
                
                downloaded_file = mp3_files[0]
                try:
                    print(f"[Flask] Using file: {os.path.basename(downloaded_file)}")
                except:
                    print(f"[Flask] Using first MP3 file found")
            
            t_after_download = time.time()
            print(f"[Flask] Time for download and conversion: {t_after_download - t_before_download:.2f}s")
            
            # Read the MP3 file and stream it back
            def generate():
                try:
                    with open(downloaded_file, 'rb') as f:
                        data = f.read(8192)
                        while data:
                            yield data
                            data = f.read(8192)
                    t_end = time.time()
                    print(f"[Flask] Total request time: {t_end - t_start:.2f}s")
                except Exception as e:
                    print(f"[Flask] Error during streaming: {e}")
                finally:
                    # Clean up the file after streaming
                    try:
                        if os.path.exists(downloaded_file):
                            os.unlink(downloaded_file)
                        if os.path.exists(temp_dir):
                            shutil.rmtree(temp_dir, ignore_errors=True)
                        remove_temp_dir(temp_dir)  # Stop tracking this directory
                    except Exception as e:
                        print(f"[Flask] Error during cleanup: {e}")
            
            # Create the Flask response with streaming content
            response = Response(stream_with_context(generate()), mimetype='audio/mpeg')
            # Ensure safe filename for header
            response.headers['Content-Disposition'] = f'attachment; filename="{sanitized_title}.mp3"'
            if os.path.exists(downloaded_file):
                response.headers['Content-Length'] = str(os.path.getsize(downloaded_file))
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            
            return response
            
        except Exception as e:
            # Clean up in case of error
            print(f"[Flask] Error during download/conversion: {e}")
            print(traceback.format_exc())
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir, ignore_errors=True)
            remove_temp_dir(temp_dir)  # Stop tracking this directory when error occurs
            raise e

    except yt_dlp.utils.DownloadError as e:
        # Error handling for yt-dlp
        print(f"[Flask] yt-dlp download error: {e}")
        error_message = str(e)
        status_code = 500
        public_error_message = f"YouTube download error: {error_message}"
        
        if "video is unavailable" in error_message.lower():
            status_code = 404
            public_error_message = "Video unavailable."
        elif "private video" in error_message.lower():
            status_code = 403
            public_error_message = "Video is private."
        elif "age restricted" in error_message.lower():
            status_code = 403
            public_error_message = "Video is age-restricted and requires login."
        elif "429" in error_message or "too many requests" in error_message.lower():
            status_code = 429
            public_error_message = "Rate limited by YouTube. Please try again later."
            
        return jsonify({'error': public_error_message}), status_code

    except requests.exceptions.RequestException as e:
        print(f"[Flask] Request error fetching audio stream: {e}")
        return jsonify({'error': f'Failed to fetch audio stream from source: {str(e)}'}), 502

    except Exception as e:
        print(f"[Flask] Generic error: {e}")
        print(traceback.format_exc())
        return jsonify({'error': f'An unexpected error occurred: {str(e)}'}), 500

# Route for a simple health check or root
@app.route("/")
def root():
    return jsonify({"status": "Flask backend is running"})

# Limit number of workers to prevent overload
max_workers = 3
download_executor = ThreadPoolExecutor(max_workers=max_workers)

# Add new endpoint to support concurrent downloads on the backend
@app.route("/batch-download", methods=['POST'])
def batch_download():
    video_ids = request.json.get('videoIds', [])
    if not video_ids:
        return jsonify({"error": "No video IDs provided"}), 400
        
    # Limit the number of videos processed simultaneously
    if len(video_ids) > 20:
        return jsonify({"error": "Too many videos requested. Maximum 20 videos per batch."}), 400
        
    batch_id = str(uuid.uuid4())
    os.makedirs(f"temp/{batch_id}", exist_ok=True)
    add_temp_dir(f"temp/{batch_id}")
    
    # Start simultaneous processing on the server
    futures = []
    for video_id in video_ids:
        futures.append(download_executor.submit(download_and_convert, video_id, batch_id))
    
    # Return batch_id so client can check status
    return jsonify({"batch_id": batch_id, "total_videos": len(video_ids)}), 202

if __name__ == '__main__':
    # Perform initial cleanup when starting server
    print("[Flask] Cleaning up any leftover temporary files from previous runs...")
    try:
        temp_dir = tempfile.gettempdir()
        temp_folders = glob.glob(os.path.join(temp_dir, "tmp*"))
        
        for folder in temp_folders:
            mp3_files = glob.glob(os.path.join(folder, "*.mp3"))
            webm_files = glob.glob(os.path.join(folder, "*.webm"))
            if mp3_files or webm_files:
                try:
                    shutil.rmtree(folder, ignore_errors=True)
                    print(f"[Flask] Removed old temp folder: {folder}")
                except Exception:
                    pass
    except Exception as e:
        print(f"[Flask] Error during startup cleanup: {e}")
    
    # Get port from environment variable or default to 5328
    port = int(os.environ.get('PORT', 5328))
    
    # Ensure FFmpeg is installed
    import subprocess
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
        print("[Flask] FFmpeg is installed and working")
    except Exception as e:
        print(f"[Flask] Warning: FFmpeg might not be installed or accessible: {e}")
        
    # Run the app (debug=True helps with development, but disable for production)
    app.run(host='0.0.0.0', port=port, debug=True)