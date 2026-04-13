"use client";

import {useEffect,useRef} from "react";
import { PoseLandmarker,FilesetResolver} from "@mediapipe/tasks-vision";

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null); //<HTMLVideoElement> は「この入れ物はvideo要素を入れる」というTSの型指定
  const canvasRef = useRef<HTMLCanvasElement>(null);

// MediaPipeとカメラの初期化・姿勢検出をする非同期処理
useEffect(() => {
  let poseLandmarker: PoseLandmarker;
  
  // MediaPipe姿勢推定モデルの初期化関数
  const init = async () => {
    // WebAssemblyファイルをCDNから読み込む指定
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );
    // MediaPipeの姿勢推定モデルをオプション付きで初期化
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions:{
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
      },
      runningMode: "VIDEO", // 動画フレーム単位での推定モード
      numPoses: 1, // 検出する人数（1人に限定）
    });
  // カメラ映像の初期化関数
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  if (videoRef.current){
    videoRef.current.srcObject = stream; // ビデオ要素にカメラ映像をセット
    videoRef.current.onloadedmetadata = () => {
      videoRef.current?.play(); // ビデオのメタデータが読み込まれたら再生開始
      detectPose(); // 姿勢検出を開始
    };
  }


  };
  
  // 姿勢検出のメイン処理
  const detectPose = () => {
    // ビデオ要素またはキャンバス要素が無ければ処理を中止
    if (!videoRef.current || !canvasRef.current) return;
    const canvas = canvasRef.current;

    // キャンバスに描画するための2Dコンテキストを取得
    const ctx = canvas.getContext("2d");

    // コンテキスト取得に失敗したら処理を中止
    if (!ctx) return;

    // キャンバスのサイズをビデオ映像のサイズと同じに設定
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    // これをしないと座標がズレて骨格が正しい位置に表示されない

    // 毎フレーム呼ばれる検出関数
    const detect = () => {
      // 現在のビデオフレームから姿勢ランドマーク（骨格33点）を検出
      const results = poseLandmarker.detectForVideo(
        videoRef.current!,
        performance.now() // 現在の時刻（ミリ秒）をタイムスタンプとして渡す
      );
      
      // キャンバスをクリアして前のフレームの描画を消す
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 検出された全ランドマーク（人物1人分の33点の座標）をループ
      results.landmarks.forEach((landmark) => {
        // 1人分の全ランドマークについて、各点を描画
        landmark.forEach((point) => {
          // 新しい円形パスを開始
          ctx.beginPath();
          // 骨格の各点を赤い円で描画（座標値は0～1の正規化値なのでキャンバスサイズを掛ける）
          ctx.arc(
            point.x * canvas.width,
            point.y * canvas.height,
            5, // 円の半径（ピクセル）
            0,
            2 * Math.PI
          );
          // 円の色を赤に設定
          ctx.fillStyle = "red";
          // 円を塗りつぶし描画
          ctx.fill();
        });
      });
      
      // 次のフレームでdetect()を呼ぶようスケジュール（ブラウザの描画タイミングに合わせる）
      requestAnimationFrame(detect);
    };

    // 最初のフレーム検出を開始
    detect();
  };

init();
},[]);
  
  return (
    <div style={{position: "relative"}}>
      <video ref={videoRef} autoPlay playsInline />
      <canvas ref={canvasRef} style={{position: "absolute", top: 0, left: 0}} />
    </div>
  );
}