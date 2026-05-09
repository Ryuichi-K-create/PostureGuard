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
};

// 崩れ状態が何ms続いたらアラートを出すか
const ALERT_DELAY_MS = 5000;

// ポモドーロの作業/休憩時間（ms）
const POMODORO_WORK_MS = 25 * 60 * 1000;
const POMODORO_BREAK_MS = 5 * 60 * 1000;

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
    let poseLandmarker: PoseLandmarker;

    const init = async () => {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
      );
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          detectPose();
        };
      }
    };

    const detectPose = () => {
      if (!videoRef.current || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // canvas のピクセルサイズを動画に合わせる（CSSでの表示サイズとは別物）
      canvas.width = videoRef.current.videoWidth;
      canvas.height = videoRef.current.videoHeight;

      const detect = () => {
        const results = poseLandmarker.detectForVideo(
          videoRef.current!,
          performance.now()
        );

        ctx.clearRect(0, 0, canvas.width, canvas.height);

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

        // 次フレームを予約。setIntervalと違い画面リフレッシュに同期するので滑らか
        requestAnimationFrame(detect);
      };

      detect();
    };

    init();

    // クリーンアップ：コンポーネント破棄時にカメラを止める
    return () => {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
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
    if (!landmarks) return;
    baselineRef.current = computeMetrics(landmarks);
    setCalibrated(true);
    issueStartRef.current = null;
    alertingRef.current = false;
  };

  // ── キーボードショートカット：Space で再キャリブレーション
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // input/textareaにフォーカスがあるときは無視
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space") {
        e.preventDefault();
        calibrate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      <header className="border-b border-white/10 backdrop-blur-sm">
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
      </header>

      {/* ─── メイン2カラム ─── */}
      <main className="max-w-7xl mx-auto px-6 py-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* ── 左：映像エリア ── */}
        <section className="space-y-4">
          <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black shadow-2xl">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              className="w-full h-auto block scale-x-[-1] object-cover" 
            />
            <canvas
              ref={canvasRef}
              className="absolute top-0 left-0 w-full h-full pointer-events-none scale-x-[-1]"
            />

            {/* ステータスバッジ */}
            <div
              className={`absolute top-3 left-3 px-3 py-1.5 rounded-full text-sm font-bold shadow-lg ${statusColor}`}
            >
              {calibrated ? `状態: ${status === "ok" ? "良好" : status}` : "未キャリブレーション"}
            </div>

            {/* キャリブレーションボタン */}
            <button
              onClick={calibrate}
              className="absolute top-3 right-3 px-4 py-2 rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500 text-slate-900 font-bold text-sm shadow-lg hover:opacity-90 transition"
            >
              姿勢を記録 (Space)
            </button>

            {/* ポモドーロ表示（有効時のみ・左下にオーバーレイ）*/}
            {settings.pomodoroEnabled && (
              <div className="absolute bottom-3 left-3 px-3 py-2 rounded-lg bg-black/60 backdrop-blur border border-white/10">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  {pomodoroPhase === "work" ? "作業中" : "休憩中"}
                </div>
                <div className="text-2xl font-mono font-bold tabular-nums">
                  {formatMmSs(pomodoroRemainingMs)}
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
          {/* 統計カード */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
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

          {/* 設定カード */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur space-y-3">
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

          {/* 通知の状態カード */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur text-sm">
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
