"use client";

import {useEffect,useRef} from "react";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const startCamera = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    };

    startCamera();
  }, []);

  return (
    <div>
      <h1>Posture Guard</h1>
      <video ref={videoRef} autoPlay playsInline />
    </div>
  );
}