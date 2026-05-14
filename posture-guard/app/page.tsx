"use client";

// React フック群
// useEffect: マウント時/依存変化時の副作用
// useRef: 再レンダリングを跨いで保持する箱（DOMや最新値の参照に使う）
// useState: 値の変更で再レンダリングを起こしたいUI状態に使う
import { useEffect, useRef, useState } from "react";
// MediaPipe の Pose Landmarker（骨格検出）と WASM ローダー
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// ─── 型定義 ───────────────────────────────────────────────

// キャリブレーションで保存する基準値
type Baseline = {
  noseY: number;        // 鼻のY座標（うつむき検出用）
  earDist: number;      // 耳間距離（前のめり=カメラに近づくと大きくなる）
  shoulderDiff: number; // 左右肩のY差（肩崩れ検出用）
};

// 検出される崩れの種類（"ok" は崩れていない状態）
type PostureIssue = "ok" | "うつむき" | "前のめり" | "肩崩れ";

// 感度プリセット（厳しいほど早く検出される）
type Sensitivity = "ゆるめ" | "普通" | "厳しめ";

// ユーザー設定（localStorageに保存）
type Settings = {
  soundEnabled: boolean;        // ビープ音を鳴らすか
  notificationEnabled: boolean; // デスクトップ通知を出すか
  sensitivity: Sensitivity;     // 検出感度
  pomodoroEnabled: boolean;     // ポモドーロタイマーを使うか
  autoPipEnabled: boolean;      // タブを離れたら自動でPiP小窓を開くか
  mosaicEnabled: boolean;       // 背景を自動でモザイク化するか（プライバシー保護）
};

// 1日分の崩れ統計（日付が変わったらリセットする）
type Stats = {
  date: string;                              // "YYYY-MM-DD"
  count: Record<Exclude<PostureIssue, "ok">, number>; // 種類別カウント
};

// ポモドーロのフェーズ
type PomodoroPhase = "work" | "break";

// ─── 定数 ─────────────────────────────────────────────────

// 感度ごとの閾値（数値が小さいほど敏感）
// nose: 鼻のY座標がこの差を超えたら「うつむき」
// ear : 耳間距離が基準のこの倍率を超えたら「前のめり」
// shoulder: 肩のY差がこの差を超えたら「肩崩れ」
const SENSITIVITY_TABLE: Record<Sensitivity, { nose: number; ear: number; shoulder: number }> = {
  "ゆるめ": { nose: 0.08, ear: 1.25, shoulder: 0.08 },
  "普通":   { nose: 0.05, ear: 1.15, shoulder: 0.05 },
  "厳しめ": { nose: 0.03, ear: 1.10, shoulder: 0.03 },
};

// 設定のデフォルト値（localStorageに何もないときに使う）
const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  notificationEnabled: true,
  sensitivity: "普通",
  pomodoroEnabled: false,
  autoPipEnabled: false,
  mosaicEnabled: false, // 初期は無効（処理コストがあるのでユーザー選択制）
};

// 崩れ状態が何ms続いたらアラートを出すか
const ALERT_DELAY_MS = 5000;

// ポモドーロの作業/休憩時間（ms）
const POMODORO_WORK_MS = 25 * 60 * 1000;
const POMODORO_BREAK_MS = 5 * 60 * 1000;

// PiP小窓のサイズプリセット
// normal: 映像表示 / minimized: 帯のみ
// ChromeのDocument PiPの最小高さは ~60-80px（バージョン依存）。それ未満はクランプされる。
// 60 を要求して、ブラウザの自然な最小に着地させる
const PIP_NORMAL_SIZE = { width: 240, height: 200 };
const PIP_MINIMIZED_SIZE = { width: 240, height: 50 };

// localStorage のキー
const LS_SETTINGS = "postureguard.settings.v1";
const LS_STATS = "postureguard.stats.v1";

// ─── ヘルパー ─────────────────────────────────────────────

// 今日の日付を "YYYY-MM-DD" 形式で取得（タイムゾーン依存に注意：ローカル基準）
const todayKey = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// 空の日次統計を作る
const emptyStats = (): Stats => ({
  date: todayKey(),
  count: { "うつむき": 0, "前のめり": 0, "肩崩れ": 0 },
});

// ms を "MM:SS" にフォーマット（ポモドーロ表示用）
const formatMmSs = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
};

// ─── コンポーネント ───────────────────────────────────────

export default function Home() {
  // カメラ映像の <video> 要素への参照
  const videoRef = useRef<HTMLVideoElement>(null);
  // 骨格を描画する <canvas> 要素への参照
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 最新ランドマーク。stateにすると毎フレーム再レンダリング走って重いのでrefで持つ
  const latestLandmarksRef = useRef<any>(null);

  // キャリブで取った基準値。毎フレーム判定で参照するのでref
  const baselineRef = useRef<Baseline | null>(null);

  // 崩れが始まった時刻（ms）。OKに戻ったらnullに戻す
  const issueStartRef = useRef<number | null>(null);

  // アラート再生中フラグ。多重再生防止
  const alertingRef = useRef<boolean>(false);

  // UI表示用のstate（毎フレームではなく状態が変わったときだけ更新）
  const [status, setStatus] = useState<PostureIssue>("ok");
  const [calibrated, setCalibrated] = useState<boolean>(false);

  // 設定state（UIで操作される）
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 設定の最新値をrefにミラーする：detectPose内のクロージャから最新設定を見るため
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  // 1日分の崩れ統計
  const [stats, setStats] = useState<Stats>(emptyStats);

  // ポモドーロ：現在のフェーズ（作業 or 休憩）と残り時間ms
  const [pomodoroPhase, setPomodoroPhase] = useState<PomodoroPhase>("work");
  const [pomodoroRemainingMs, setPomodoroRemainingMs] = useState<number>(POMODORO_WORK_MS);

  // ブラウザ通知の許可状態（"default" | "granted" | "denied"）
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>("default");

  // キャリブレーション直後のフィードバック表示
  // null=非表示 / "success"=記録成功 / "no-landmark"=骨格未検出で失敗
  // 1.5秒後に自動で null に戻す（setTimeoutで実装）
  const [calibrateFeedback, setCalibrateFeedback] = useState<null | "success" | "no-landmark">(null);
  // 直前のsetTimeoutをキャンセルするための参照（連打対策）
  const feedbackTimerRef = useRef<number | null>(null);

  // ── 背景モザイク用のオフスクリーンcanvas群 ──────────────
  // 毎フレーム create するとGCが頻発するので useRef でキャッシュする
  // mosaic: 低解像度バッファ。ここに縮小描画→拡大して四角いブロックを作る
  // mask  : セグメンテーションマスクをImageDataで描く中継canvas
  // person: 元映像を描いてマスクで人物だけ切り抜く中継canvas
  const mosaicCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const personCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // detect関数を外から再起動できるよう ref に保持。
  // PiPが閉じる瞬間、PiP windowに紐づいたrAFは実行されないままになり、ループが切断される。
  // pagehide で detectRef.current() を呼んで main window で再起動する
  const detectRef = useRef<(() => void) | null>(null);

  // resizePipの最新版をrefに置く：PiPクリック委譲ハンドラから常に最新を呼ぶため
  const resizePipRef = useRef<((mode: "normal" | "minimized") => void) | null>(null);

  // Document Picture-in-Picture：映像コンテナを丸ごと小窓に移動するために参照を持つ
  const videoContainerRef = useRef<HTMLDivElement>(null);
  // PiPを閉じたときに「どこに戻すか」を覚えておくための元親要素
  const originalParentRef = useRef<HTMLElement | null>(null);
  // PiPウィンドウのハンドル。開いていないときはnull
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  // PiP小窓のサイズモード（normal=映像表示 / minimized=細長い帯のみ）
  const [pipSize, setPipSize] = useState<"normal" | "minimized">("normal");
  // 映像コンテナがPiPに居るか（minimized時の見た目切替に使う）
  const [containerInPip, setContainerInPip] = useState<boolean>(false);
  // detectループ内のクロージャから最新値を見るためのrefミラー
  // 用途：PiP中はモザイク合成が壊れるので自動的にOFFに切り替える判定
  const containerInPipRef = useRef<boolean>(false);
  // ブラウザがDocument PiP APIをサポートしているか（マウント後に判定）
  const [pipSupported, setPipSupported] = useState<boolean>(false);

  // マウント後にAPIの有無を判定（SSRでwindowが無いので初期値はfalse）
  useEffect(() => {
    setPipSupported(typeof window !== "undefined" && "documentPictureInPicture" in window);
  }, []);

  // ── containerInPipの最新値をrefにミラーする ────────────
  // detectループ内のクロージャは初回マウント時の値を掴んでいるので、
  // この同期が無いと「PiPに入ったのにモザイクが消えない」状態になる
  useEffect(() => {
    containerInPipRef.current = containerInPip;
  }, [containerInPip]);

  // ── 初回マウント：localStorageから設定と統計を読む ───────
  useEffect(() => {
    // 設定の復元
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw) as Settings;
        // デフォルトとマージしてキー欠落に強くする
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      }
    } catch {
      // 壊れていたら無視してデフォルトのまま
    }

    // 統計の復元（日付が違ったら今日分にリセット）
    try {
      const raw = localStorage.getItem(LS_STATS);
      if (raw) {
        const parsed = JSON.parse(raw) as Stats;
        if (parsed.date === todayKey()) {
          setStats(parsed);
        } else {
          setStats(emptyStats());
        }
      }
    } catch {
      // 無視
    }

    // 通知の許可状態を初期反映
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotifPermission(Notification.permission);
    }
  }, []);

  // ── settings 変更時：localStorageに保存 + refにミラー ────
  useEffect(() => {
    settingsRef.current = settings;
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    } catch {
      // 容量・プライバシーモード等で失敗しても致命ではない
    }
  }, [settings]);

  // ── stats 変更時：localStorageに保存 ─────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(LS_STATS, JSON.stringify(stats));
    } catch {
      // 同上
    }
  }, [stats]);

  // ── MediaPipe + カメラ初期化（マウント時1回）─────────────
  useEffect(() => {
    // クリーンアップで停止できるよう、リソース参照を useEffect スコープに保持する
    // PoseLandmarker: WASMモデル(~7MB)。close()しないとメモリリーク
    let poseLandmarker: PoseLandmarker | null = null;
    // requestAnimationFrame の戻り値。cancelAnimationFrame に渡してループを止める
    let rafId: number | null = null;
    // React Strict Mode は dev で useEffect を2回走らせる(クリーンアップ忘れを検出するため)。
    // 1回目のクリーンアップ後も async init が走り続けると、カメラ/モデル/rAFが二重化する。
    // このフラグで「すでに中断された」ことを各 await の後にチェックする。
    let cancelled = false;

    const init = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      // await の後では cancelled になっている可能性がある(Strict Mode 2回目クリーンアップ)
      if (cancelled) return;

      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        },
        runningMode: "VIDEO",
        numPoses: 1,
        // 人物セグメンテーションマスクを結果に含める（背景モザイクで使う）
        // この指定が無いと results.segmentationMasks は undefined になる
        outputSegmentationMasks: true,
      });
      // ここでも cancelled チェック。確保したモデルは解放してから抜ける
      if (cancelled) {
        poseLandmarker.close();
        poseLandmarker = null;
        return;
      }

      // 解像度を 640x480 に制限。{ video: true } だとカメラ最大解像度(1080pや4K)で取得され、
      // 毎フレームのGPU/CPU負荷が跳ねるため明示的に下げる。MediaPipeは内部でさらに縮小するので
      // 姿勢推定の精度には影響しない。idealは「可能ならこの値、無理なら近い値」の意味。
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      // 中断中に取れたストリームも明示的に止める。放置するとカメラランプが点きっぱなしになる
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        poseLandmarker?.close();
        poseLandmarker = null;
        return;
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          // metadata 到着が遅れて cancelled 後になることもあるので最終チェック
          if (!cancelled) detectPose();
        };
      }
    };

    // ── オフスクリーンcanvasを必要サイズに整える共通ヘルパー ──
    // 既存があれば再利用、サイズが違えば width/height を再設定する。
    // width/height の代入は内部でピクセルバッファを再確保するため、
    // 毎フレーム同じ値で代入してもコストはほぼゼロだが、念のため変化時のみ書く。
    const ensureCanvas = (
      ref: { current: HTMLCanvasElement | null },
      w: number,
      h: number
    ): HTMLCanvasElement => {
      if (!ref.current) ref.current = document.createElement("canvas");
      if (ref.current.width !== w) ref.current.width = w;
      if (ref.current.height !== h) ref.current.height = h;
      return ref.current;
    };

    // ── 背景モザイク＋人物くり抜き合成 ──
    // 流れ:
    //   ① 低解像度バッファに縮小描画 → メインに拡大描画 = ピクセレート（モザイク）背景
    //   ② マスクをImageDataとして描き起こす（人物=alpha255 / 背景=alpha0）
    //   ③ 元映像を別オフスクリーンに描き、destination-in でマスクをかけて人物だけ残す
    //   ④ ③をメインに重ねる → 結果：背景モザイク＋人物クリア
    const drawMosaicWithMask = (
      ctx: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      mask: any,
      canvas: HTMLCanvasElement
    ) => {
      // モザイクの粗さ。値が大きいほど四角が大きい
      const pixelSize = 16;
      const lowW = Math.max(1, Math.floor(canvas.width / pixelSize));
      const lowH = Math.max(1, Math.floor(canvas.height / pixelSize));

      // ① 低解像度バッファに描いて、メインへ拡大描画でピクセレート背景を作る
      const mosaic = ensureCanvas(mosaicCanvasRef, lowW, lowH);
      const mCtx = mosaic.getContext("2d");
      if (!mCtx) return;
      mCtx.drawImage(video, 0, 0, lowW, lowH);
      // imageSmoothingEnabled=false が「四角」を作る核心。trueだと補間されて滲む
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mosaic, 0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;

      // ② マスクをImageDataにしてオフスクリーンに描く
      // MediaPipeのマスクは0.0〜1.0の確率値（Float32）。閾値0.5で人物判定
      const maskData = mask.getAsFloat32Array?.() as Float32Array | undefined;
      if (!maskData) return; // 取れない実装の場合はモザイク背景だけにして抜ける
      const maskW = mask.width;
      const maskH = mask.height;
      const maskCanvas = ensureCanvas(maskCanvasRef, maskW, maskH);
      const mskCtx = maskCanvas.getContext("2d");
      if (!mskCtx) return;
      const img = mskCtx.createImageData(maskW, maskH);
      // ピクセルループ：alphaチャンネルだけ使う（RGBは白で固定）
      // destination-in 合成では alpha だけが意味を持つ
      for (let i = 0; i < maskData.length; i++) {
        const idx = i * 4;
        img.data[idx] = 255;
        img.data[idx + 1] = 255;
        img.data[idx + 2] = 255;
        img.data[idx + 3] = maskData[i] > 0.5 ? 255 : 0;
      }
      mskCtx.putImageData(img, 0, 0);

      // ③ 元映像を描いてマスクでくり抜き
      const person = ensureCanvas(personCanvasRef, canvas.width, canvas.height);
      const pCtx = person.getContext("2d");
      if (!pCtx) return;
      pCtx.globalCompositeOperation = "source-over";
      pCtx.clearRect(0, 0, person.width, person.height);
      pCtx.drawImage(video, 0, 0, person.width, person.height);
      // destination-in: 既存ピクセル(=元映像) と マスクの alpha の交差だけ残す
      pCtx.globalCompositeOperation = "destination-in";
      pCtx.drawImage(maskCanvas, 0, 0, person.width, person.height);
      // 次フレームに備えてデフォルトに戻す（このcanvasは使い回すので大事）
      pCtx.globalCompositeOperation = "source-over";

      // ④ 人物部分だけ抜かれた画像をメインcanvasの上に重ねる
      ctx.drawImage(person, 0, 0);
    };

    const detectPose = () => {
      if (!videoRef.current || !canvasRef.current || !poseLandmarker) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // canvas のピクセルサイズを動画に合わせる（CSSでの表示サイズとは別物）
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;

      const detect = () => {
        // cancelled 後やリソース解放後に走らないよう毎フレームガード。
        // これを書かないと幽霊rAFループが続いてCPUを食い続ける
        if (cancelled || !poseLandmarker) return;
        const video = videoRef.current;
        if (!video) return;

        const results = poseLandmarker.detectForVideo(video, performance.now());

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // モザイクON & マスクが取れた時だけ背景合成を実行
        // OFFのときは従来通り：videoがCSSで見えていてcanvasは骨格だけ
        // PiP小窓に居る間はモザイク合成を停止する：
        //   PiP の document に video が移動した状態で別 document のオフスクリーン canvas へ
        //   drawImage すると合成結果が崩れるブラウザがあり、視認性も悪化するため。
        const mask = (results as any).segmentationMasks?.[0];
        if (settingsRef.current.mosaicEnabled && !containerInPipRef.current && mask) {
          drawMosaicWithMask(ctx, video, mask, canvas);
        }

        const landmarks = results.landmarks[0];
        latestLandmarksRef.current = landmarks ?? null;

        // 骨格描画（点だけシンプルに）
        if (landmarks) {
          landmarks.forEach((point) => {
            ctx.beginPath();
            ctx.arc(
              point.x * canvas.width,
              point.y * canvas.height,
              5,
              0,
              2 * Math.PI
            );
            // ステータスに応じて色を変える：OKは緑、崩れ中は赤
            ctx.fillStyle = baselineRef.current && issueStartRef.current ? "#ef4444" : "#22c55e";
            ctx.fill();
          });

          // 基準値があるなら毎フレーム判定
          if (baselineRef.current) {
            const issue = judgePosture(landmarks, baselineRef.current);
            handleIssue(issue);
          }
        }

        // canvasが属するdocumentのwindowでrAFを呼ぶのが核心。
        // 通常はmain window、PiP中はPiP windowを返す。
        // main windowはタブ非表示時にrAFを停止するが、PiP windowは「常に可視」なので止まらない
        // → タブを切り替えてもバックグラウンドで姿勢検出が続く
        const frameWin = canvas.ownerDocument.defaultView ?? window;
        rafId = frameWin.requestAnimationFrame(detect);
      };

      // PiPが閉じる瞬間にrAFが死ぬ問題のため、外から再起動できるよう ref に保持
      detectRef.current = detect;
      detect();
    };

    init();

    // クリーンアップ：rAFループ停止 + カメラ停止 + WASMモデル解放
    // これを全部やらないと、Strict Mode 二重実行や HMR(保存)のたびに資源が累積して
    // 最終的に Node 側のメモリ枯渇や GPU 負荷増大につながる
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      poseLandmarker?.close();
      poseLandmarker = null;
    };
  }, []);

  // ── ポモドーロタイマー：1秒ごとに残り時間を減らす ────────
  useEffect(() => {
    if (!settings.pomodoroEnabled) return;
    const id = window.setInterval(() => {
      setPomodoroRemainingMs((prev) => Math.max(0, prev - 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [settings.pomodoroEnabled]);

  // ── ポモドーロ：残り0になったらフェーズ切り替え＋通知 ────
  useEffect(() => {
    if (!settings.pomodoroEnabled) return;
    if (pomodoroRemainingMs > 0) return;

    const next: PomodoroPhase = pomodoroPhase === "work" ? "break" : "work";
    setPomodoroPhase(next);
    setPomodoroRemainingMs(next === "break" ? POMODORO_BREAK_MS : POMODORO_WORK_MS);

    // フェーズが切り替わるタイミングで通知＋ビープ
    if (next === "break") {
      sendNotification("休憩しましょう", "5分間目と肩を休めてください");
    } else {
      sendNotification("作業を再開しましょう", "25分集中していきましょう");
    }
    if (settingsRef.current.soundEnabled) playBeep();
  }, [pomodoroRemainingMs, pomodoroPhase, settings.pomodoroEnabled]);

  // ── ポモドーロのトグルOFF時：作業フェーズにリセット ─────
  useEffect(() => {
    if (!settings.pomodoroEnabled) {
      setPomodoroPhase("work");
      setPomodoroRemainingMs(POMODORO_WORK_MS);
    }
  }, [settings.pomodoroEnabled]);

  // ── 現在のランドマークから3指標を計算 ───────────────────
  const computeMetrics = (landmarks: any) => {
    const nose = landmarks[0];
    const leftEar = landmarks[7];
    const rightEar = landmarks[8];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    const noseY = nose.y;
    const earDist = Math.hypot(
      leftEar.x - rightEar.x,
      leftEar.y - rightEar.y
    );
    const shoulderDiff = Math.abs(leftShoulder.y - rightShoulder.y);

    return { noseY, earDist, shoulderDiff };
  };

  // ── 基準値と現在値を比較して崩れの種類を返す ───────────
  // 感度（settingsRef経由）でしきい値を切り替える
  const judgePosture = (landmarks: any, base: Baseline): PostureIssue => {
    const m = computeMetrics(landmarks);
    const t = SENSITIVITY_TABLE[settingsRef.current.sensitivity];

    if (m.noseY > base.noseY + t.nose) return "うつむき";
    if (m.earDist > base.earDist * t.ear) return "前のめり";
    if (m.shoulderDiff > base.shoulderDiff + t.shoulder) return "肩崩れ";
    return "ok";
  };

  // ── 崩れ状態の継続を時間で管理し、5秒継続でアラート ────
  const handleIssue = (issue: PostureIssue) => {
    if (issue === "ok") {
      issueStartRef.current = null;
      alertingRef.current = false;
      setStatus((prev) => (prev === "ok" ? prev : "ok"));
      return;
    }

    setStatus((prev) => (prev === issue ? prev : issue));

    if (issueStartRef.current === null) {
      issueStartRef.current = performance.now();
      return;
    }

    const elapsed = performance.now() - issueStartRef.current;
    if (elapsed > ALERT_DELAY_MS && !alertingRef.current) {
      alertingRef.current = true;

      // 設定に応じて音と通知を出す
      if (settingsRef.current.soundEnabled) playBeep();
      if (settingsRef.current.notificationEnabled) {
        sendNotification(
          "姿勢が崩れています",
          `${issue}を検出しました。背筋を伸ばしましょう。`
        );
      }

      // 統計に1件加算（関数形式で前の値を確実に取る）
      setStats((prev) => {
        // 日付が変わっていたら今日分にリセットしてから加算
        const base = prev.date === todayKey() ? prev : emptyStats();
        return {
          ...base,
          count: { ...base.count, [issue]: base.count[issue] + 1 },
        };
      });
    }
  };

  // ── 440Hzサイン波を0.5秒鳴らす（音声ファイル不要）─────
  const playBeep = () => {
    const ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    osc.type = "sine";
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  };

  // ── デスクトップ通知（許可済みのときだけ）──────────────
  const sendNotification = (title: string, body: string) => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification(title, { body, icon: "/favicon.ico" });
    } catch {
      // モバイル等で new Notification が禁止されている場合は黙って無視
    }　　　　
  };

  // ── 通知許可をリクエスト（ボタンから呼ぶ）──────────────
  const requestNotifPermission = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setNotifPermission(result);
  };

  // ── 「姿勢を記録」ボタンで基準値を保存 ─────────────────
  const calibrate = () => {
    const landmarks = latestLandmarksRef.current;

    // 連打されたとき前のタイマーを破棄して、表示時間がリセットされるようにする
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }

    // 骨格が未検出ならフィードバックだけ出して終了（ユーザーに失敗を伝える）
    if (!landmarks) {
      setCalibrateFeedback("no-landmark");
      feedbackTimerRef.current = window.setTimeout(() => {
        setCalibrateFeedback(null);
        feedbackTimerRef.current = null;
      }, 1500);
      return;
    }

    baselineRef.current = computeMetrics(landmarks);
    setCalibrated(true);
    issueStartRef.current = null;
    alertingRef.current = false;

    // 成功フィードバックを1.5秒表示
    setCalibrateFeedback("success");
    feedbackTimerRef.current = window.setTimeout(() => {
      setCalibrateFeedback(null);
      feedbackTimerRef.current = null;
    }, 1500);

    // 音設定がONなら短いビープで聴覚フィードバックも返す
    if (settingsRef.current.soundEnabled) playBeep();
  };

  // ── Document Picture-in-Picture：小窓を開く ───────────────
  // タブを離れても姿勢検出が動き続けるのがこの機能の核心。
  // PiPウィンドウは「可視」扱いなので、その中で動くrequestAnimationFrameは
  // メインタブが非表示でも止まらない（detectPose側で切替済み）。
  // PiP空状態（コンテナがメインに居る）に表示する「監視中」プレースホルダ。
  // ReactではなくDOM直書き：常駐モードでReactツリーをPiPに置く構造になっていないため
  const showPipPlaceholder = (pip: Window) => {
    if (!pip || pip.closed) return;
    if (pip.document.getElementById("pip-placeholder")) return;
    const ph = pip.document.createElement("div");
    ph.id = "pip-placeholder";
    ph.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;gap:8px;padding:0 12px;color:#fff;font:500 12px sans-serif;background:#0f172a;";
    ph.innerHTML =
      '<span style="width:10px;height:10px;border-radius:50%;background:#34d399;flex-shrink:0;"></span><span>PostureGuard - 監視中</span>';
    pip.document.body.appendChild(ph);
  };

  const removePipPlaceholder = (pip: Window | null) => {
    pip?.document.getElementById("pip-placeholder")?.remove();
  };

  const openPip = async (options?: { moveContent?: boolean; initialSize?: "normal" | "minimized" }) => {
    // moveContent=trueでコンテナをPiPに移す（手動オープン用）。
    // false は「PiP常駐モード」で、コンテナはメインに残してウィンドウだけ用意する用途
    const moveContent = options?.moveContent ?? true;
    const sizeMode = options?.initialSize ?? pipSize;

    // 非対応ブラウザ（Firefox/Safari）では何もしない。ボタン側でも無効化済み
    if (!("documentPictureInPicture" in window)) return;
    if (!videoContainerRef.current) return;

    // requestWindow は常に normalサイズで呼ぶ。
    // disallowReturnToOpener: PiPの「タブに戻る」ボタンを非表示にする（Chrome 125+）。
    //   このボタンで閉じると user activation 不足で自動再オープン不可になるため、
    //   そもそも誤って押せないようにする
    const pip = await (window as any).documentPictureInPicture.requestWindow({
      width: PIP_NORMAL_SIZE.width,
      height: PIP_NORMAL_SIZE.height,
      disallowReturnToOpener: true,
    });

    // PiPは別documentなのでTailwindのCSSが効かない → 全シートをコピーする
    [...document.styleSheets].forEach((sheet) => {
      try {
        const rules = [...sheet.cssRules].map((r) => r.cssText).join("");
        const style = pip.document.createElement("style");
        style.textContent = rules;
        pip.document.head.appendChild(style);
      } catch {
        const link = pip.document.createElement("link");
        link.rel = "stylesheet";
        link.type = sheet.type;
        link.media = sheet.media.toString();
        link.href = sheet.href ?? "";
        pip.document.head.appendChild(link);
      }
    });

    pip.document.body.style.margin = "0";
    pip.document.body.style.background = "#000";
    pip.document.body.style.overflow = "hidden";

    // Chrome仕様: resizeTo も user activation 必須なので、自動でのサイズ変更は不可能。
    // PiPウィンドウは常に PIP_NORMAL_SIZE のまま。「最小化」は中身の切替で表現する

    if (moveContent) {
      originalParentRef.current = videoContainerRef.current.parentElement;
      pip.document.body.append(videoContainerRef.current);
      setContainerInPip(true);
    } else {
      // 常駐モード初期：コンテナはメインに残しつつ、PiP内にプレースホルダ
      showPipPlaceholder(pip);
      setContainerInPip(false);
    }

    setPipWindow(pip);
    setPipSize(sizeMode);

    // PiPが閉じられた（×ボタン or 「タブに戻る」ボタン）ときの後始末
    pip.addEventListener("pagehide", () => {
      const inPip = videoContainerRef.current && videoContainerRef.current.ownerDocument !== document;
      if (inPip && originalParentRef.current && videoContainerRef.current) {
        originalParentRef.current.append(videoContainerRef.current);
      }
      setPipWindow(null);
      setContainerInPip(false);

      // 最後のrAFはPiP windowに紐づいていて、windowが閉じられた瞬間に実行されず破棄される
      if (detectRef.current) {
        window.requestAnimationFrame(detectRef.current);
      }

      // 注: Chrome仕様で pagehide 内の requestWindow は user activation不足で
      // 必ず NotAllowedError になるため、自動再オープンは諦める。
      // 再開したい場合はユーザーが「小窓で常駐」ボタンを手動で押す運用
    });
  };

  // ── PiP小窓のサイズを切り替える ─────────────────────────
  // resizeToはPiP windowに対して呼び出す。pipWindowが無いときは状態だけ覚えておく
  // （次回openPipで使われる）
  const resizePip = (mode: "normal" | "minimized") => {
    setPipSize(mode);
    if (!pipWindow) return;
    const s = mode === "minimized" ? PIP_MINIMIZED_SIZE : PIP_NORMAL_SIZE;
    // デバッグログ：実際にブラウザがサイズ要求を反映したかを確認できるように残す
    console.log(`[PiP] resize → ${mode}`, { request: s, before: { w: pipWindow.outerWidth, h: pipWindow.outerHeight } });
    try {
      pipWindow.resizeTo(s.width, s.height);
      requestAnimationFrame(() => {
        if (pipWindow) console.log("[PiP] after:", { w: pipWindow.outerWidth, h: pipWindow.outerHeight });
      });
    } catch (e) {
      console.warn("[PiP] resize failed:", e);
    }
  };

  // 最新の resizePip を ref にミラー。PiP内ネイティブハンドラは関数を保持するので
  // refを経由して常に最新版（最新のpipWindow参照を持つ版）を呼べるようにする
  resizePipRef.current = resizePip;

  // ── 自動PiP（常駐モード）：PiPを閉じずにコンテナを行き来させる ───
  // requestWindow が user gesture 起因しか許可しないブラウザ制約を回避するため、
  // ON時に1度だけ最小化サイズでPiPを開いて常駐させ、以降は visibilitychange で
  // 「コンテナの移動」と「resizeTo」だけ行う。
  useEffect(() => {
    if (!settings.autoPipEnabled) return;
    if (!pipSupported) return;

    // 初期：PiPがまだなら最小化サイズで開く（コンテナはメインに留める）
    if (!pipWindow) {
      openPip({ moveContent: false, initialSize: "minimized" }).catch((e) => {
        console.warn("[AutoPiP] failed initial open (need user gesture):", e);
      });
      return; // PiPが開いたら pipWindow 依存で useEffect が再実行される
    }

    const onVisChange = () => {
      if (!pipWindow || !videoContainerRef.current) return;

      // Chrome仕様：resizeToはvisibilitychange内では user activation不足で拒否される。
      // サイズ変更は諦め、コンテナの移動とstate切替だけで「最小化」を表現する
      if (document.hidden) {
        // タブ離脱：コンテナをPiPに移動 → 映像表示
        removePipPlaceholder(pipWindow);
        if (videoContainerRef.current.ownerDocument === document) {
          originalParentRef.current = videoContainerRef.current.parentElement;
          pipWindow.document.body.append(videoContainerRef.current);
        }
        setPipSize("normal");
        setContainerInPip(true);
      } else {
        // タブ復帰：コンテナをメインに戻す → PiPはプレースホルダだけになる
        if (videoContainerRef.current.ownerDocument !== document && originalParentRef.current) {
          originalParentRef.current.append(videoContainerRef.current);
        }
        setPipSize("minimized");
        setContainerInPip(false);
        showPipPlaceholder(pipWindow);
        if (detectRef.current) window.requestAnimationFrame(detectRef.current);
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [settings.autoPipEnabled, pipSupported, pipWindow]);

  // ── PiP内クリックのネイティブ委譲 ───────────────────────
  // React 18 の合成イベントシステムは createRoot した document にしか attach されない。
  // PiP windowに移したボタンの onClick は届かないため、PiPのdocumentに直接
  // クリックリスナーを置いて data-pip-action 属性で分岐する
  useEffect(() => {
    if (!pipWindow) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const action = target?.closest?.("[data-pip-action]")?.getAttribute("data-pip-action");
      if (!action) return;
      if (action === "minimize") resizePipRef.current?.("minimized");
      else if (action === "restore") resizePipRef.current?.("normal");
    };
    pipWindow.document.addEventListener("click", handler);
    return () => pipWindow.document.removeEventListener("click", handler);
  }, [pipWindow]);

  // ── キーボードショートカット：Space で再キャリブレーション / M で最小化トグル
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // input/textareaにフォーカスがあるときは無視
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        calibrate();
      }
      // M キーで PiP のサイズトグル（PiPが開いていてコンテナがPiP内のときだけ）
      if (e.code === "KeyM" && pipWindow && containerInPip) {
        e.preventDefault();
        resizePipRef.current?.(pipSize === "minimized" ? "normal" : "minimized");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // pipWindow/containerInPip/pipSize に依存するので、状態変化で再登録する
  }, [pipWindow, containerInPip, pipSize]);

  // ── 派生値（UI表示）────────────────────────────────────
  // ステータスバッジの色
  const statusColor =
    status === "ok"
      ? "bg-emerald-500/90"
      : "bg-red-500/90 animate-pulse";

  // 今日の崩れ合計回数
  const totalIssues =
    stats.count["うつむき"] + stats.count["前のめり"] + stats.count["肩崩れ"];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* ─── ヘッダー ─── */}
      <header className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* ロゴ代わりの簡易マーク */}
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center font-black text-slate-900">
              P
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">PostureGuard</h1>
              <p className="text-xs text-slate-400">リアルタイム姿勢チェッカー</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 通知許可ボタン（未許可のときだけ表示）*/}
            {notifPermission !== "granted" && (
              <button
                onClick={requestNotifPermission}
                className="text-xs px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 transition border border-white/10"
              >
                通知を許可する
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ─── メイン2カラム ─── */}
      <main className="max-w-7xl mx-auto px-6 py-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* ── 左：映像エリア ── */}
        {/* 映像は素のピクセル等倍で表示。w-full で巨大化させると blur と相まって極端に重くなる */}
        <section className="space-y-4">
          {/* PiP移動の対象コンテナ。姿勢が崩れているときは赤縁＋脈動でリング表示。
              PiP小窓に移動してもこのclass判定がそのまま効くのがDocument PiPの利点。
              border-4 + transition-colors で違和感なく色変化させる */}
          <div
            ref={videoContainerRef}
            style={
              // 手動最小化時 & コンテナがPiP内のときだけサイズ固定
              pipWindow && pipSize === "minimized" && containerInPip
                ? { width: PIP_MINIMIZED_SIZE.width, height: PIP_MINIMIZED_SIZE.height }
                : undefined
            }
            className={`relative inline-block rounded-2xl overflow-hidden border-4 bg-black shadow-2xl transition-colors duration-200 ${
              calibrated && status !== "ok"
                ? "border-red-500 ring-4 ring-red-500/40 animate-pulse"
                : "border-white/10"
            }`}
          >
            {/* モザイクON時は video を invisible にして、canvas に描かれる合成画像だけを見せる
                display:none ではなくinvisibleにする理由：
                  - display:none だと video の領域サイズが消える
                  - canvas は absolute で video の上に重ねている設計のため、
                    親<div>の高さが video のサイズに依存する → display:none でレイアウトが崩れる
                  - invisible（visibility:hidden）なら見えないが領域は維持される */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className={`block scale-x-[-1] ${
                settings.mosaicEnabled && !containerInPip ? "invisible" : ""
              } ${pipWindow && pipSize === "minimized" && containerInPip ? "hidden" : ""}`}
            />
            <canvas
              ref={canvasRef}
              className={`absolute top-0 left-0 pointer-events-none scale-x-[-1] ${
                pipWindow && pipSize === "minimized" && containerInPip ? "hidden" : ""
              }`}
            />

            {/* ステータスバッジ */}
            <div
              className={`absolute top-3 left-3 px-3 py-1.5 rounded-full text-sm font-bold shadow-lg ${statusColor}`}
            >
              {calibrated ? `状態: ${status === "ok" ? "良好" : status}` : "未キャリブレーション"}
            </div>

            {/* キャリブレーションボタン
                - コンテナがPiP小窓に居る間だけ非表示（メインでは常に表示）
                - 自動小窓化ONでもメインタブでは表示される */}
            {!containerInPip && (
              <button
                onClick={calibrate}
                className="absolute top-3 right-3 px-4 py-2 rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-900 font-bold text-sm shadow-lg hover:opacity-90 active:scale-95 active:from-cyan-600 active:to-emerald-600 transition-transform duration-100"
              >
                姿勢を記録 (Space)
              </button>
            )}

            {/* キャリブレーション結果のフィードバック（中央オーバーレイ）
                成功: 緑のチェック、失敗: 黄色の警告。1.5秒で消える */}
            {calibrateFeedback && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div
                  className={`px-6 py-4 rounded-2xl shadow-2xl border-2 font-bold text-lg animate-pop-in ${
                    calibrateFeedback === "success"
                      ? "bg-emerald-500/95 border-emerald-300 text-white"
                      : "bg-amber-500/95 border-amber-300 text-slate-900"
                  }`}
                >
                  {calibrateFeedback === "success"
                    ? "✓ 基準姿勢を記録しました"
                    : "⚠ 骨格が検出できません"}
                </div>
              </div>
            )}

            {/* ポモドーロ表示（有効時のみ・左下にオーバーレイ）*/}
            {settings.pomodoroEnabled && (
              <div className="absolute bottom-3 left-3 px-3 py-2 rounded-lg bg-black/80 border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  {pomodoroPhase === "work" ? "作業中" : "休憩中"}
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums">
                  {formatMmSs(pomodoroRemainingMs)}
                </div>
              </div>
            )}

            {/* サイズ切替トグル（PiP内 & normal時のみ）。
                右上に配置。ステータスバッジ（左上）とは横並びになるが被らない */}
            {pipWindow && pipSize === "normal" && containerInPip && (
              <div className="absolute top-2 right-2 flex gap-1 rounded-md bg-black/70 border border-white/10 p-0.5 text-[10px] z-10">
                <button
                  data-pip-action="restore"
                  onClick={() => resizePip("normal")}
                  className="px-1.5 py-0.5 rounded bg-white text-slate-900 font-bold"
                >
                  通常
                </button>
                <button
                  data-pip-action="minimize"
                  onClick={() => resizePip("minimized")}
                  className="px-1.5 py-0.5 rounded text-slate-300 hover:bg-white/10"
                >
                  最小化
                </button>
              </div>
            )}

            {/* 最小化バー（PiP内 & minimized時）。inset-0でコンテナ全体を覆う。
                右端は normal時と同じ「通常 / 最小化」トグル（現在状態がハイライト） */}
            {pipWindow && pipSize === "minimized" && containerInPip && (
              <div className="absolute inset-0 flex items-center justify-between px-3 bg-slate-900 text-white text-xs gap-2 z-20">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      !calibrated
                        ? "bg-slate-500"
                        : status === "ok"
                        ? "bg-emerald-400"
                        : "bg-red-500 animate-pulse"
                    }`}
                  />
                  <span className="truncate font-medium">
                    {calibrated ? (status === "ok" ? "姿勢OK" : status) : "未キャリブレーション"}
                  </span>
                </div>
                <div className="flex gap-1 rounded-md bg-black/40 border border-white/10 p-0.5 text-[10px] shrink-0">
                  <button
                    data-pip-action="restore"
                    onClick={() => resizePip("normal")}
                    className="px-1.5 py-0.5 rounded text-slate-300 hover:bg-white/10"
                  >
                    通常
                  </button>
                  <button
                    data-pip-action="minimize"
                    onClick={() => resizePip("minimized")}
                    className="px-1.5 py-0.5 rounded bg-white text-slate-900 font-bold"
                  >
                    最小化
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 使い方ヒント */}
          <div className="text-xs text-slate-400 px-1">
            正しい姿勢で座って <span className="text-slate-200 font-semibold">「姿勢を記録」</span> を押すと基準が登録されます。崩れが5秒続くと通知されます。
          </div>
        </section>

        {/* ── 右：サイドパネル ── */}
        <aside className="space-y-4">
          {/* 統計カード（backdrop-blurはGPU負荷源だったので除去。半透明だけ残す） */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold">今日の崩れ</h2>
              <span className="text-xs text-slate-400">{stats.date}</span>
            </div>
            <div className="text-4xl font-bold mb-3">
              {totalIssues}
              <span className="text-sm font-normal text-slate-400 ml-1">回</span>
            </div>
            <div className="space-y-1.5 text-sm">
              <StatRow label="うつむき" value={stats.count["うつむき"]} color="bg-amber-400" />
              <StatRow label="前のめり" value={stats.count["前のめり"]} color="bg-pink-400" />
              <StatRow label="肩崩れ" value={stats.count["肩崩れ"]} color="bg-cyan-400" />
            </div>
            <button
              onClick={() => setStats(emptyStats())}
              className="mt-4 text-xs text-slate-400 hover:text-slate-200 transition"
            >
              リセット
            </button>
          </div>

          {/* 設定カード（backdrop-blur除去） */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 space-y-3">
            <h2 className="font-bold mb-1">設定</h2>

            <ToggleRow
              label="アラート音"
              checked={settings.soundEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, soundEnabled: v }))}
            />
            <ToggleRow
              label="デスクトップ通知"
              checked={settings.notificationEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, notificationEnabled: v }))}
            />
            <ToggleRow
              label="ポモドーロ (25/5分)"
              checked={settings.pomodoroEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, pomodoroEnabled: v }))}
            />
            <ToggleRow
              label="背景モザイク"
              checked={settings.mosaicEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, mosaicEnabled: v }))}
            />
            {/* 自動PiPトグル：対応ブラウザのみ表示。disabled時は薄く見せる */}
            {pipSupported && (
              <ToggleRow
                label="タブを離れたら自動で小窓化"
                checked={settings.autoPipEnabled}
                onChange={(v) => setSettings((s) => ({ ...s, autoPipEnabled: v }))}
              />
            )}

            <div className="pt-2">
              <div className="text-sm mb-2">検出感度</div>
              <div className="flex gap-1 rounded-lg bg-black/30 p-1">
                {(["ゆるめ", "普通", "厳しめ"] as Sensitivity[]).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setSettings((s) => ({ ...s, sensitivity: opt }))}
                    className={`flex-1 text-xs py-1.5 rounded-md transition ${
                      settings.sensitivity === opt
                        ? "bg-white text-slate-900 font-bold"
                        : "text-slate-300 hover:bg-white/10"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 通知の状態カード（backdrop-blur除去） */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">通知の許可</span>
              <span
                className={`px-2 py-0.5 rounded-full text-xs ${
                  notifPermission === "granted"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : notifPermission === "denied"
                    ? "bg-red-500/20 text-red-300"
                    : "bg-slate-500/20 text-slate-300"
                }`}
              >
                {notifPermission === "granted"
                  ? "許可済み"
                  : notifPermission === "denied"
                  ? "ブロック"
                  : "未設定"}
              </span>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

// ─── 子要素：統計の1行 ───────────────────────────────────
function StatRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-slate-300 flex-1">{label}</span>
      <span className="font-mono tabular-nums text-slate-100">{value}</span>
    </div>
  );
}

// ─── 子要素：ON/OFFトグル ────────────────────────────────
// ネイティブの input[type=checkbox] をスタイリングしたシンプルなスイッチ
function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer text-sm">
      <span className="text-slate-200">{label}</span>
      <span
        className={`relative inline-block w-10 h-6 rounded-full transition ${
          checked ? "bg-emerald-500" : "bg-slate-600"
        }`}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </span>
    </label>
  );
}
