import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const videoId = url.searchParams.get("videoId");
  
  if (!videoId) {
    return NextResponse.json(
      { error: "Missing videoId parameter" },
      { status: 400 }
    );
  }

  try {
    const backendUrl = `http://localhost:5328/download?videoId=${videoId}`;
    
    console.log(`Proxying request to backend: ${backendUrl}`);
    
    const response = await fetch(backendUrl, {
      method: "GET",
      headers: {
        "Accept": "*/*",
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Backend error: ${response.status} - ${errorText}`);
      
      return NextResponse.json(
        { error: `Backend error: ${response.statusText}` },
        { status: response.status }
      );
    }

    // Get the file contents
    const data = await response.arrayBuffer();
    
    // Get the headers we want to keep
    const contentType = response.headers.get("Content-Type") || "audio/mpeg";
    const contentDisposition = response.headers.get("Content-Disposition") || 'attachment; filename="audio.mp3"';
    
    // Create a new response with the file contents and appropriate headers
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": contentDisposition,
        "Content-Length": String(data.byteLength),
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
    
  } catch (error) {
    console.error("Error proxying to backend:", error);
    return NextResponse.json(
      { error: "Failed to connect to backend server. Is it running?" },
      { status: 502 }
    );
  }
}