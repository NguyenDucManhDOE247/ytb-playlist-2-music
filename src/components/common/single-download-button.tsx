import { Button } from "@/components/ui/button";
import { useCallback, useMemo, useState } from "react";

interface SingleDownloadButtonProps {
  videoId: string;
  title: string;
}

type DownloadStatus = "init" | "fetching" | "downloading" | "finished";

export function SingleDownloadButton({
  videoId,
  title,
}: SingleDownloadButtonProps) {
  const [status, setStatus] = useState<DownloadStatus>("init");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const startDownload = useCallback(async () => {
    setStatus("fetching");
    setProgress(0);

    try {
      // Fetch the MP3 directly from our API endpoint
      const response = await fetch(`/api/youtube/download?videoId=${videoId}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Error downloading: ${response.status} - ${errorText}`);
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      setStatus("downloading");
      
      // Get content length for progress tracking
      const contentLength = Number(response.headers.get("Content-Length") || "0");
      let downloadedSize = 0;
      
      // Read the response stream
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      
      if (!reader) throw new Error("Reader is undefined");
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          downloadedSize += value.length;
          setProgress(contentLength > 0 ? downloadedSize / contentLength : 0);
        }
      }

      // Get filename from Content-Disposition header or use video title
      let filename = `${title.replace(/[^\w\s]/gi, "_").substring(0, 100)}.mp3`;
      const contentDisposition = response.headers.get("Content-Disposition");
      if (contentDisposition) {
        const matches = /filename="([^"]+)"/.exec(contentDisposition);
        if (matches && matches[1]) {
          filename = matches[1];
        }
      }

      // Create blob URL directly from received MP3 data
      const mp3Blob = new Blob(chunks, { type: "audio/mpeg" });
      const mp3Url = URL.createObjectURL(mp3Blob);

      setDownloadUrl(mp3Url);
      setStatus("finished");
      
      // Automatically download
      const link = document.createElement("a");
      link.href = mp3Url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
    } catch (error) {
      console.error("Error during download:", error);
      alert(`Download failed: ${error.message || "Unknown error"}`);
      setStatus("init"); // Reset status to allow retrying
    }
  }, [videoId, title]);

  const handleDownload = () => {
    if (downloadUrl) {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `${title.replace(/[^\w\s]/gi, "_").substring(0, 100)}.mp3`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const progressText = useMemo(() => {
    return `${(progress * 100).toFixed(0)}%`;
  }, [progress]);

  const getStatusDisplay = () => {
    switch (status) {
      case "init":
        return "Download MP3";
      case "fetching":
        return "Preparing...";
      case "downloading":
        return progressText;
      case "finished":
        return "Download Again";
      default:
        return "Download";
    }
  };

  return (
    <div className="flex gap-2 w-full">
      <Button
        onClick={status === "finished" ? handleDownload : startDownload}
        disabled={status !== "init" && status !== "finished"}
        className="flex-1"
        variant={status === "finished" ? "outline" : "default"}
        style={{
          background: status === "downloading" 
            ? `linear-gradient(to right, #3b82f6 ${progress * 100}%, #1e3a8a ${progress * 100}%)`
            : undefined
        }}
      >
        {getStatusDisplay()}
      </Button>
    </div>
  );
}
