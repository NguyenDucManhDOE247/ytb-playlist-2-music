import { Video } from "@/app/page";
import JSZip from "jszip";
import { useCallback, useState } from "react";
import { useProgressStore } from "../stores/progress-store";

// Reduce to just 1 download at a time to avoid rate limiting
const MAX_CONCURRENT_CONVERSIONS = 1;
// Increase delay between downloads
const DELAY_BETWEEN_DOWNLOADS = 3000; // 3 seconds
// Add chunk size to handle large playlists
const CHUNK_SIZE = 30; // Process videos in chunks of 30

const fetchWithRetry = async (url: string, options: any, retries = 3) => {
  try {
    console.log(`Attempting to fetch: ${url}`);
    const response = await fetch(url, options);
    console.log(`Fetch response status: ${response.status}`);
    return response;
  } catch (err) {
    console.error(`Fetch error:`, err);
    if (retries <= 1) throw err;
    console.log(`Waiting before retry...`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second wait before retry
    console.log(`Retrying fetch, ${retries-1} attempts left...`);
    return fetchWithRetry(url, options, retries-1);
  }
};

// Helper function to split an array into chunks
const chunkArray = <T>(array: T[], chunkSize: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
};

const useBatchConversion = (videos: Video[]) => {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [completedChunks, setCompletedChunks] = useState(0);

  const handleBatchConversion = useCallback(async () => {
    if (videos.length === 0) {
      return alert("Please select at least one video to download.");
    }

    setIsConverting(true);
    setCompletedChunks(0);

    try {
      // Get list of selected video IDs
      const selectedVideoIds = videos.map(v => v.id);
      console.log(`Starting batch download for ${selectedVideoIds.length} videos`);
      
      // Split videos into manageable chunks
      const videoChunks = chunkArray(selectedVideoIds, CHUNK_SIZE);
      const totalChunksCount = videoChunks.length;
      setTotalChunks(totalChunksCount);
      
      let successfulChunks = 0;
      
      // Process each chunk
      for (let chunkIndex = 0; chunkIndex < videoChunks.length; chunkIndex++) {
        setCurrentChunk(chunkIndex + 1);
        const chunk = videoChunks[chunkIndex];
        const zip = new JSZip();
        let successCount = 0;
        
        // Process videos in this chunk
        for (let i = 0; i < chunk.length; i++) {
          const videoId = chunk[i];
          const video = videos.find((v) => v.id === videoId);
          if (!video) continue;

          try {
            console.log(`Processing video ${i+1}/${chunk.length} in chunk ${chunkIndex+1}/${videoChunks.length}: ${video.title}`);
            
            useProgressStore.getState().startVideo(videoId, video.title);
            useProgressStore.getState().setStatus(videoId, "fetching");

            // Fetch video with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 second timeout
            
            const response = await fetchWithRetry(
              `/api/youtube/download?videoId=${videoId}`,
              { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            
            if (!response.ok) {
              const errorText = await response.text();
              console.error(`Error fetching ${video.title}: ${response.status} - ${errorText}`);
              
              // If rate limited, wait longer and try again
              if (response.status === 429) {
                console.log("Rate limited, waiting 10 seconds before trying next video");
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
                
                // Mark as error but continue with next video
                useProgressStore.getState().setStatus(videoId, "error");
                continue;
              }
              
              throw new Error(`Failed to fetch: ${response.statusText}`);
            }

            const contentLength = Number(response.headers.get("Content-Length") || "0");
            let downloadedSize = 0;

            // Read response stream
            useProgressStore.getState().setStatus(videoId, "downloading");
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            
            if (!reader) throw new Error("Reader is undefined");
            
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                chunks.push(value);
                downloadedSize += value.length;
                
                // Update progress
                useProgressStore.getState().setProgress(
                  videoId, 
                  contentLength > 0 ? downloadedSize / contentLength : 0
                );
              }
            }

            // Get filename from Content-Disposition or use video title
            let filename = `${video.title.replace(/[^\w\s]/gi, "_").substring(0, 100)}.mp3`;
            const contentDisposition = response.headers.get("Content-Disposition");
            if (contentDisposition) {
              const matches = /filename="([^"]+)"/.exec(contentDisposition);
              if (matches && matches[1]) {
                filename = matches[1];
              }
            }
            
            console.log(`Adding "${filename}" to ZIP`);
            
            // MP3 data has been converted by the backend
            const mp3Data = new Blob(chunks, { type: "audio/mpeg" });
            
            // Add to ZIP
            zip.file(filename, mp3Data);
            
            // Mark as completed
            useProgressStore.getState().setStatus(videoId, "completed");
            successCount++;
            
            // Wait longer between requests to avoid rate limiting
            console.log(`Waiting ${DELAY_BETWEEN_DOWNLOADS/1000} seconds before next download`);
            await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_DOWNLOADS));
            
          } catch (error) {
            console.error(`Error processing ${video?.title}:`, error);
            if (video) {
              useProgressStore.getState().setStatus(videoId, "error");
            }
            // Continue with next video instead of stopping the entire process
            
            // Wait a bit longer after an error
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }

        // If we have successful downloads in this chunk, create and download a ZIP
        if (successCount > 0) {
          // Create ZIP file and start download for this chunk
          console.log(`Generating ZIP file for chunk ${chunkIndex+1}...`);
          
          const zipBlob = await zip.generateAsync({ 
            type: "blob",
            compression: "DEFLATE",
            compressionOptions: { level: 5 } 
          });
          
          if (zipBlob.size === 0) {
            console.log("Generated ZIP file is empty, skipping download");
            continue;
          }
          
          console.log(`ZIP generated successfully, size: ${zipBlob.size} bytes`);
          const zipUrl = URL.createObjectURL(zipBlob);
          
          // Automatically download
          const link = document.createElement("a");
          link.href = zipUrl;
          link.download = `youtube_playlist_part${chunkIndex+1}.zip`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          // Free memory
          URL.revokeObjectURL(zipUrl);
          
          // Short pause between ZIP downloads
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Track completed chunks
          successfulChunks++;
          setCompletedChunks(successfulChunks);
        }
      }

      // Store the total number of chunks completed before showing alert
      const finalCount = successfulChunks;
      alert(`Batch download complete! Downloaded in ${finalCount} parts.`);
    } catch (error) {
      console.error("Error during batch conversion:", error);
      // Get current count of completed chunks for the error message
      const currentCompleted = completedChunks;
      alert(`An error occurred during batch conversion ${currentCompleted > 0 ? `after downloading ${currentCompleted} parts` : ''}: ${error instanceof Error ? error.message : "Unknown error"}. Please try again.`);
    } finally {
      setIsConverting(false);
      setCurrentChunk(0);
      setTotalChunks(0);
    }
  }, [videos, completedChunks]);

  return {
    handleBatchConversion,
    isConverting,
    downloadUrl,
    currentChunk,
    totalChunks,
    completedChunks,
  };
};

export default useBatchConversion;
