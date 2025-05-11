import { Video } from "@/app/page";
import JSZip from "jszip";
import { useCallback, useState } from "react";
import { useProgressStore } from "../stores/progress-store";

// Reduce the number of concurrent downloads to prevent overloading the server
const MAX_CONCURRENT_CONVERSIONS = 2;

const fetchWithRetry = async (url: string, options: any, retries = 3) => {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (retries <= 1) throw err;
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`Retrying fetch, ${retries-1} attempts left...`);
    return fetchWithRetry(url, options, retries-1);
  }
}

const useBatchConversion = (videos: Video[]) => {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const progressState = useProgressStore((state) => state.progress);

  const handleBatchConversion = useCallback(async () => {
    if (videos.length === 0) {
      return alert("Please select at least one video to download.");
    }

    const zip = new JSZip();
    setIsConverting(true);

    try {
      // Get list of selected video IDs
      const selectedVideoIds = videos.map(v => v.id);
      console.log(`Starting batch download for ${selectedVideoIds.length} videos`);
      
      // Process videos one by one instead of simultaneously
      for (let i = 0; i < selectedVideoIds.length; i++) {
        const videoId = selectedVideoIds[i];
        const video = videos.find((v) => v.id === videoId);
        if (!video) continue;

        try {
          console.log(`Processing video ${i+1}/${selectedVideoIds.length}: ${video.title}`);
          
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
          
        } catch (error) {
          console.error(`Error processing ${video.title}:`, error);
          useProgressStore.getState().setStatus(videoId, "error");
          // Continue with next video instead of stopping the entire process
        }
        
        // Pause a bit between requests to avoid overloading the server
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Create ZIP file and start download
      console.log("Generating ZIP file...");
      
      const zipBlob = await zip.generateAsync({ 
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 5 } 
      });
      
      if (zipBlob.size === 0) {
        throw new Error("Generated ZIP file is empty");
      }
      
      console.log(`ZIP generated successfully, size: ${zipBlob.size} bytes`);
      const zipUrl = URL.createObjectURL(zipBlob);
      setDownloadUrl(zipUrl);

      // Automatically download
      const link = document.createElement("a");
      link.href = zipUrl;
      link.download = "youtube_playlist.zip";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      alert("Batch download complete!");
    } catch (error) {
      console.error("Error during batch conversion:", error);
      alert(`An error occurred during batch conversion: ${error.message || "Unknown error"}. Please try again.`);
    } finally {
      setIsConverting(false);
    }
  }, [videos]);

  return {
    handleBatchConversion,
    isConverting,
    downloadUrl,
  };
};

export default useBatchConversion;
