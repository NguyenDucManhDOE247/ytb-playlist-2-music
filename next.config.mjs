/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "i.ytimg.com",
      },
    ],
  },

  // Configure rewrites to proxy API requests to the Flask backend
  async rewrites() {
    return [
      {
        source: "/api/youtube/:path*",
        destination: "http://localhost:5328/:path*", // Make sure Flask is running on port 5328
      },
    ];
  },
};

export default nextConfig;