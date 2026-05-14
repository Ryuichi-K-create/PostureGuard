"use client";

// React フック群
// useEffect: マウント時/依存変化時の副作用
// useRef: 再レンダリングを跨いで保持する箱（DOMや最新値の参照に使う）
// useState: 値の変更で再レンダリングを起こしたいUI状態に使う
import { useEffect, useRef, useState } from "react";
// MediaPipe の Pose Landmarker（骨格検出）と WASM ローダー
import { PoseLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
// Recharts：履歴グラフ用
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

// ─── 型定義 ───────────────────────────────────────────────

// キャリブレーションで保存する基準値
type Baseline = {
  noseY: number;        // 鼻のY座標（うつむき検出用）
  earDist: number;      // 耳間距離（前のめり=カメラに近づくと大きくなる）
  shoulderDiff: number; // 左右肩のY差（肩崩れ検出用）
};

// 検出される崩れの種類（"ok" は崩れていない状態）
type PostureIssue = "ok" | "うつむき" | "前のめり" | "肩崩れ";

// UI表示用のステータス：崩れの種類 + 骨格が取れていない「未検出」
// 判定ロジック(judgePosture)は PostureIssue を返すが、骨格そのものが見えない状態は
// 判定の外側で扱いたいので、UI state だけ拡張する
type Status = PostureIssue | "未検出";

// 感度プリセット（厳しいほど早く検出される）
type Sensitivity = "ゆるめ" | "普通" | "厳しめ";

// ユーザー設定（localStorageに保存）
type Settings = {
  soundEnabled: boolean;        // ビープ音を鳴らすか
  sensitivity: Sensitivity;     // 検出感度
  pomodoroEnabled: boolean;     // ポモドーロタイマーを使うか
  mosaicEnabled: boolean;       // 背景を自動でモザイク化するか（プライバシー保護）
};

// 旧形式：1日分の統計（移行用にだけ残す）
type LegacyStats = {
  date: string;
  count: Record<Exclude<PostureIssue, "ok">, number>;
};

// 1日分の記録：種類別カウント + 動作時間
type DailyRecord = {
  count: Record<Exclude<PostureIssue, "ok">, number>;
  uptimeMs: number; // キャリブ後 ＆ 骨格検出中の累計ミリ秒
};

// 履歴：日付("YYYY-MM-DD")をキーにしたマップ（無限に貯める）
type History = Record<string, DailyRecord>;

// 履歴表示の期間切替
type Period = "7days" | "30days" | "90days" | "all";

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
  sensitivity: "普通",
  pomodoroEnabled: false,
  mosaicEnabled: false, // 初期は無効（処理コストがあるのでユーザー選択制）
};

// 崩れ状態が何ms続いたらアラートを出すか
const ALERT_DELAY_MS = 5000;

// 骨格が連続でこのms数だけ取れなかったら「未検出」とみなす
// 一瞬の途切れ（逆光・腕で顔が隠れる等）でUIがちらつかないよう猶予を設ける
const NO_LANDMARK_GRACE_MS = 1000;

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
const LS_STATS = "postureguard.stats.v1";       // 旧キー（移行用に読み込みのみ）
const LS_HISTORY = "postureguard.history.v1";   // 新キー：日付ごとのDailyRecord
const LS_BASELINE = "postureguard.baseline.v1"; // キャリブレーション基準値

// 動作時間のフラッシュ間隔（refで貯めて、この間隔でstate/localStorageへ反映）
const UPTIME_FLUSH_MS = 2000;
// 1フレームdtの最大ガード値。タブ復帰直後の巨大差分（>1秒）は加算しない
const FRAME_DT_MAX = 1000;
// 期間ラベル
const PERIOD_LABELS: Record<Period, string> = {
  "7days": "7日",
  "30days": "30日",
  "90days": "90日",
  "all": "全期間",
};

// ─── ヘルパー ─────────────────────────────────────────────

// 今日の日付を "YYYY-MM-DD" 形式で取得（タイムゾーン依存に注意：ローカル基準）
const todayKey = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// 空の日次レコードを作る
const emptyDailyRecord = (): DailyRecord => ({
  count: { "うつむき": 0, "前のめり": 0, "肩崩れ": 0 },
  uptimeMs: 0,
});

// 履歴に今日のキーが無ければ初期化して返す（破壊的ではなく新オブジェクト）
const ensureDay = (h: History, day: string): History => {
  if (h[day]) return h;
  return { ...h, [day]: emptyDailyRecord() };
};

// 1日分の合計回数（種類を合算）
const dailyTotal = (r: DailyRecord): number =>
  r.count["うつむき"] + r.count["前のめり"] + r.count["肩崩れ"];

// 旧形式LegacyStatsを新形式Historyへ変換（移行用）
const migrateLegacy = (legacy: LegacyStats): History => ({
  [legacy.date]: { count: legacy.count, uptimeMs: 0 },
});

// 日付文字列を Date に戻す（タイムゾーン依存）
const parseDateKey = (key: string): Date => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// Date を "YYYY-MM-DD" 形式に
const formatDateKey = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

// 期間→日数（"all"はnull）
const periodToDays = (p: Period): number | null => {
  if (p === "7days") return 7;
  if (p === "30days") return 30;
  if (p === "90days") return 90;
  return null;
};

// グラフ描画用のデータ配列を作る
// - 期間が"all"なら履歴にある日付だけ
// - それ以外は今日から N 日前まで全日を埋める（空欄日は0）
type ChartRow = {
  date: string;      // "YYYY-MM-DD"
  label: string;     // "5/14" のような短縮形（XAxis用）
  total: number;     // 崩れ合計回数
  uptimeHours: number;
  rate: number;      // 回数/時間（動作時間0のときは0）
};

const buildChartData = (h: History, period: Period): ChartRow[] => {
  const days = periodToDays(period);
  const toRow = (key: string, rec: DailyRecord): ChartRow => {
    const total = dailyTotal(rec);
    const uptimeHours = rec.uptimeMs / 3_600_000;
    return {
      date: key,
      label: `${parseDateKey(key).getMonth() + 1}/${parseDateKey(key).getDate()}`,
      total,
      uptimeHours,
      rate: uptimeHours > 0 ? total / uptimeHours : 0,
    };
  };

  if (days === null) {
    // 全期間：履歴にある日付だけソートして
    return Object.keys(h)
      .sort()
      .map((key) => toRow(key, h[key]));
  }

  // N日：今日から N-1 日前まで埋める
  const rows: ChartRow[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = formatDateKey(d);
    rows.push(toRow(key, h[key] ?? emptyDailyRecord()));
  }
  return rows;
};

// ms を "MM:SS" にフォーマット（ポモドーロ表示用）
const formatMmSs = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${m}:${s}`;
};

// ms を "Xh Ym" にフォーマット（動作時間表示用）
const formatHm = (ms: number): string => {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
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

  // 最後にアラートを出した時刻（ms）。nullは未発報。5秒ごとに繰り返すために使う
  const lastAlertTimeRef = useRef<number | null>(null);

  // 骨格が取れなくなった最初の時刻（ms）。取れたらnullに戻す
  // ここから NO_LANDMARK_GRACE_MS 経過したら status を「未検出」に切り替える
  const noLandmarkStartRef = useRef<number | null>(null);

  // UI表示用のstate（毎フレームではなく状態が変わったときだけ更新）
  const [status, setStatus] = useState<Status>("ok");
  const [calibrated, setCalibrated] = useState<boolean>(false);

  // 設定state（UIで操作される）
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 設定の最新値をrefにミラーする：detectPose内のクロージャから最新設定を見るため
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);

  // 履歴：日付ごとのDailyRecordマップ（無限に貯める）
  const [history, setHistory] = useState<History>({});

  // 履歴グラフの期間切替
  const [historyPeriod, setHistoryPeriod] = useState<Period>("30days");
  // 履歴カードの折り畳み状態（デフォルト: 閉じた状態で設定を目立たせる）
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  // 動作時間トラッキング用
  // 前フレームの performance.now()。差分計算に使う
  const lastFrameTimeRef = useRef<number | null>(null);
  // フレームごとに加算するバッファ。UPTIME_FLUSH_MS ごとに state へ反映
  const pendingUptimeMsRef = useRef<number>(0);

  // ポモドーロ：現在のフェーズ（作業 or 休憩）と残り時間ms
  const [pomodoroPhase, setPomodoroPhase] = useState<PomodoroPhase>("work");
  const [pomodoroRemainingMs, setPomodoroRemainingMs] = useState<number>(POMODORO_WORK_MS);

  // カメラの起動/停止状態（true=映像取得中 / false=停止中）
  // OFFにするとカメラランプが消えて他アプリでカメラを使えるようになる
  const [cameraActive, setCameraActive] = useState<boolean>(true);
  // detectループ内のクロージャから最新値を見るためのrefミラー
  const cameraActiveRef = useRef<boolean>(true);

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
  // PiPを閉じたときに「どこに戻すか」を覚えておくための元親要素と次の兄弟要素
  // append()は末尾追加なので、insertBefore(container, nextSibling)で元の位置に戻す
  const originalParentRef = useRef<HTMLElement | null>(null);
  const originalNextSiblingRef = useRef<ChildNode | null>(null);
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

  // 監視の開始/停止状態。trueの間だけ稼働時間計測・姿勢崩れ検知・PiP常駐が動く
  const [isStarted, setIsStarted] = useState<boolean>(false);
  const isStartedRef = useRef<boolean>(false);

  // マウント後にAPIの有無を判定（SSRでwindowが無いので初期値はfalse）
  useEffect(() => {
    setPipSupported(typeof window !== "undefined" && "documentPictureInPicture" in window);
  }, []);

  // ── containerInPipの最新値をrefにミラーする ────────────
  useEffect(() => {
    containerInPipRef.current = containerInPip;
  }, [containerInPip]);

  // ── isStartedの最新値をrefにミラーする ──────────────────
  // detectループのクロージャは古い値を掴むため、refで最新値を渡す
  useEffect(() => {
    isStartedRef.current = isStarted;
  }, [isStarted]);

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

    // 履歴の復元（新キー優先、無ければ旧キーから移行）
    try {
      const rawHistory = localStorage.getItem(LS_HISTORY);
      if (rawHistory) {
        const parsed = JSON.parse(rawHistory) as History;
        setHistory(parsed);
      } else {
        // 旧 LS_STATS があれば移行
        const rawLegacy = localStorage.getItem(LS_STATS);
        if (rawLegacy) {
          const legacy = JSON.parse(rawLegacy) as LegacyStats;
          const migrated = migrateLegacy(legacy);
          setHistory(migrated);
          localStorage.setItem(LS_HISTORY, JSON.stringify(migrated));
          localStorage.removeItem(LS_STATS);
        }
      }
    } catch {
      // 無視
    }

    // キャリブレーション基準値の復元
    try {
      const rawBaseline = localStorage.getItem(LS_BASELINE);
      if (rawBaseline) {
        const parsed = JSON.parse(rawBaseline) as Baseline;
        baselineRef.current = parsed;
        setCalibrated(true);
      }
    } catch {
      // 壊れていたら無視
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

  // ── history 変更時：localStorageに保存 ───────────────────
  useEffect(() => {
    try {
      localStorage.setItem(LS_HISTORY, JSON.stringify(history));
    } catch {
      // 同上
    }
  }, [history]);

  // ── 動作時間のフラッシュ：refに貯めた dt を state に反映 ────
  // 毎フレームsetStateすると再レンダリングが重いので、2秒ごとにまとめて反映
  useEffect(() => {
    const id = window.setInterval(() => {
      const pending = pendingUptimeMsRef.current;
      if (pending <= 0) return;
      pendingUptimeMsRef.current = 0;

      setHistory((prev) => {
        const day = todayKey();
        const ensured = ensureDay(prev, day);
        return {
          ...ensured,
          [day]: { ...ensured[day], uptimeMs: ensured[day].uptimeMs + pending },
        };
      });
    }, UPTIME_FLUSH_MS);
    return () => window.clearInterval(id);
  }, []);

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

        // カメラがOFFのとき（srcObject=null）：canvasをクリアしてループだけ継続する。
        // OFFのまま detectForVideo を呼ぶと videoWidth=0 で内部エラーになるため先に弾く。
        if (!cameraActiveRef.current || !video.srcObject) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const frameWinOff = canvas.ownerDocument.defaultView ?? window;
          rafId = frameWinOff.requestAnimationFrame(detect);
          return;
        }

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

        // ── 動作時間の計測 ──
        // キャリブ後 & 骨格検出中 のフレームだけ、前フレームからの差分を加算
        // タブ離脱中は rAF 自体が止まるので、ここで明示的に止める必要は無い
        const nowTs = performance.now();
        const prevTs = lastFrameTimeRef.current;
        lastFrameTimeRef.current = nowTs;
        if (
          prevTs !== null &&
          baselineRef.current &&
          landmarks &&
          isStartedRef.current
        ) {
          const dt = nowTs - prevTs;
          // 復帰直後などの巨大差分はガード（外れ値を弾く）
          if (dt > 0 && dt < FRAME_DT_MAX) {
            pendingUptimeMsRef.current += dt;
          }
        }

        // 骨格描画（点だけシンプルに）
        if (landmarks) {
          // 復帰：直前まで未検出だった場合は時計をクリアして判定を再開させる
          // 骨格が戻った瞬間に handleIssue が走り、必要なら "未検出" → "ok"/"崩れ" に切り替わる
          noLandmarkStartRef.current = null;

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

          // スタート中かつ基準値があるなら毎フレーム判定
          if (baselineRef.current && isStartedRef.current) {
            const issue = judgePosture(landmarks, baselineRef.current);
            handleIssue(issue);
          }
        } else if (isStartedRef.current && baselineRef.current) {
          // 骨格が取れていない & 監視中：未検出グレース計測
          // 連続で NO_LANDMARK_GRACE_MS 続いたら "未検出" へ
          // 一瞬の途切れ（顔を手で覆う等）で揺れないよう猶予を設けてある
          handleNoLandmark();
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

  // ── 骨格が取れていないときの処理（離席・カメラ前から外れる等）────
  // 連続未検出が NO_LANDMARK_GRACE_MS を超えたら status を "未検出" にし、
  // 崩れタイマー/アラート時計をリセットする（戻ったときにアラートが即発火しないように）
  // 重要：動作時間カウントと履歴加算は landmarks がある時しか走らないので、
  //       この関数内で明示的に止める必要は無い（自動的に一時停止する）
  const handleNoLandmark = () => {
    const now = performance.now();

    // 未検出の開始時刻を記録（既に記録済みなら触らない）
    if (noLandmarkStartRef.current === null) {
      noLandmarkStartRef.current = now;
      return;
    }

    const elapsed = now - noLandmarkStartRef.current;
    if (elapsed < NO_LANDMARK_GRACE_MS) return;

    // ここから先は「確定的に未検出」とみなすゾーン
    // 崩れタイマー類をクリアして、戻ったときに OK スタートからやり直させる
    issueStartRef.current = null;
    lastAlertTimeRef.current = null;
    setStatus((prev) => (prev === "未検出" ? prev : "未検出"));
  };

  // ── 崩れ状態の継続を時間で管理し、5秒ごとにアラートを繰り返す ────
  const handleIssue = (issue: PostureIssue) => {
    if (issue === "ok") {
      issueStartRef.current = null;
      lastAlertTimeRef.current = null;
      setStatus((prev) => (prev === "ok" ? prev : "ok"));
      return;
    }

    setStatus((prev) => (prev === issue ? prev : issue));

    const now = performance.now();

    if (issueStartRef.current === null) {
      issueStartRef.current = now;
      return;
    }

    const elapsed = now - issueStartRef.current;
    // 前回のアラートからの経過時間（初回はInfinityとして扱い必ず発報）
    const sinceLastAlert = lastAlertTimeRef.current === null
      ? Infinity
      : now - lastAlertTimeRef.current;

    if (elapsed > ALERT_DELAY_MS && sinceLastAlert >= ALERT_DELAY_MS) {
      lastAlertTimeRef.current = now;

      if (settingsRef.current.soundEnabled) playBeep();

      // 履歴に1件加算（種類別カウントを保持・表示時に合算）
      setHistory((prev) => {
        const day = todayKey();
        const ensured = ensureDay(prev, day);
        const cur = ensured[day];
        return {
          ...ensured,
          [day]: {
            ...cur,
            count: { ...cur.count, [issue]: cur.count[issue] + 1 },
          },
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

  // ── cameraActive の state→ref ミラー ─────────────────────
  // detectループはクロージャで初回マウント時の値を掴んでいるため、
  // refを介さないと最新のON/OFF状態が伝わらない（settingsRefと同じパターン）
  useEffect(() => {
    cameraActiveRef.current = cameraActive;
  }, [cameraActive]);

  // ── カメラを停止する ─────────────────────────────────────
  // getTracks().stop() が「カメラランプを消す」唯一の方法。
  // srcObject = null だけではストリームは解放されず、OSレベルでカメラが占有されたまま。
  const stopCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
  };

  // ── カメラを再起動する ───────────────────────────────────
  // getUserMedia は毎回ユーザー許可を確認する（2回目以降はブラウザが自動で許可）
  // 他アプリがカメラを解放していなければ OverconstrainedError / NotReadableError が出る
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      if (videoRef.current) videoRef.current.srcObject = stream;
      setCameraActive(true);
    } catch {
      // Zoomなど他アプリが使用中のまま起動しようとした場合は黙って無視する
      // ユーザーは他アプリを閉じてから再度ボタンを押すことで解決できる
    }
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

    const baseline = computeMetrics(landmarks);
    baselineRef.current = baseline;
    setCalibrated(true);
    issueStartRef.current = null;
    lastAlertTimeRef.current = null;

    // 再読み込み後も基準値を維持するためlocalStorageに保存
    try {
      localStorage.setItem(LS_BASELINE, JSON.stringify(baseline));
    } catch {
      // 容量超過等でも致命的ではない
    }

    // 成功フィードバックを1.5秒表示
    setCalibrateFeedback("success");
    feedbackTimerRef.current = window.setTimeout(() => {
      setCalibrateFeedback(null);
      feedbackTimerRef.current = null;
    }, 1500);

    // 音設定がONなら短いビープで聴覚フィードバックも返す
    if (settingsRef.current.soundEnabled) playBeep();
  };

  // ── 監視停止ハンドラ ────────────────────────────────────────
  const handleStop = () => {
    setIsStarted(false);
    setStatus("ok");
    issueStartRef.current = null;
    lastAlertTimeRef.current = null;
    noLandmarkStartRef.current = null;
    // PiPを閉じる処理は上のuseEffect（isStarted→false検知）が担当
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
      originalNextSiblingRef.current = videoContainerRef.current.nextSibling;
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
        originalParentRef.current.insertBefore(videoContainerRef.current, originalNextSiblingRef.current);
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

  // ── 監視開始中のPiP常駐：スタート後にPiPを開き visibilitychange でコンテナを行き来させる ───
  useEffect(() => {
    if (!isStarted) return;
    if (!pipSupported) return;

    // PiPがまだなら最小化サイズで開く（コンテナはメインに留める）
    if (!pipWindow) {
      openPip({ moveContent: false, initialSize: "minimized" }).catch((e) => {
        console.warn("[PiP] failed to open (need user gesture):", e);
      });
      return; // pipWindowがセットされたら依存変化でuseEffectが再実行される
    }

    const onVisChange = () => {
      if (!pipWindow || !videoContainerRef.current) return;
      if (document.hidden) {
        // タブ離脱：コンテナをPiPに移動（復帰時に元位置へ戻せるよう兄弟も保存）
        removePipPlaceholder(pipWindow);
        if (videoContainerRef.current.ownerDocument === document) {
          originalParentRef.current = videoContainerRef.current.parentElement;
          originalNextSiblingRef.current = videoContainerRef.current.nextSibling;
          pipWindow.document.body.append(videoContainerRef.current);
        }
        setPipSize("normal");
        setContainerInPip(true);
      } else {
        // タブ復帰：コンテナを元の位置に戻す（insertBeforeで順序を保持）
        if (videoContainerRef.current.ownerDocument !== document && originalParentRef.current) {
          originalParentRef.current.insertBefore(videoContainerRef.current, originalNextSiblingRef.current);
        }
        setPipSize("minimized");
        setContainerInPip(false);
        showPipPlaceholder(pipWindow);
        if (detectRef.current) window.requestAnimationFrame(detectRef.current);
      }
    };

    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [isStarted, pipSupported, pipWindow]);

  // ── 監視停止時：PiPを閉じる ─────────────────────────────
  // isStartedがfalseになったとき、またはPiPが開いた直後にStopが押された場合に対応
  useEffect(() => {
    if (!isStarted && pipWindow && !pipWindow.closed) {
      pipWindow.close();
    }
  }, [isStarted, pipWindow]);

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
  // 優先順位: 未監視(カメラOFF) > 未検出(離席) > 崩れ中 > 良好
  // 未検出は「判定不能」の中立を示すアンバーにする
  // → 崩れ(赤)と混同せず、OK(緑)とも区別される
  const statusColor =
    !cameraActive
      ? "bg-slate-500/90"                  // グレー：カメラが止まっていて判定していない
      : status === "未検出"
      ? "bg-amber-500/90"                  // アンバー：骨格が取れていない（離席等）
      : status !== "ok"
      ? "bg-red-500/90 animate-pulse"      // 赤脈動：崩れ検出中
      : "bg-emerald-500/90";               // 緑：良好

  // 今日のレコード（無ければ空）
  const todayRecord: DailyRecord = history[todayKey()] ?? emptyDailyRecord();

  // 今日の崩れ合計回数
  const totalIssues = dailyTotal(todayRecord);

  // 履歴グラフ用のデータ（期間切替に応じて）
  const chartData = buildChartData(history, historyPeriod);

  // 期間内サマリ（合計回数・合計動作時間・平均レート）
  const periodTotalCount = chartData.reduce((s, r) => s + r.total, 0);
  const periodTotalHours = chartData.reduce((s, r) => s + r.uptimeHours, 0);
  const periodAvgRate = periodTotalHours > 0 ? periodTotalCount / periodTotalHours : 0;

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
            {/* カメラON/OFFボタン
                OFF中は赤系、ON中はデフォルト色。押すたびに stopCamera/startCamera を呼ぶ */}
            <button
              onClick={cameraActive ? stopCamera : startCamera}
              className={`text-xs px-3 py-1.5 rounded-md transition border flex items-center gap-1.5 ${
                cameraActive
                  ? "bg-white/10 hover:bg-white/20 border-white/10 text-slate-200"
                  : "bg-red-500/20 hover:bg-red-500/30 border-red-500/30 text-red-300"
              }`}
            >
              {/* ● で状態を視覚的に示す：緑=撮影中 / 赤点滅=停止中 */}
              <span className={cameraActive ? "text-emerald-400" : "text-red-400 animate-pulse"}>
                ●
              </span>
              {cameraActive ? "カメラ停止" : "カメラ起動"}
            </button>
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
              // 赤縁＋脈動は「崩れ確定」のときだけ。未検出(離席)では出さない
              calibrated && status !== "ok" && status !== "未検出"
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
              {!cameraActive
                ? "状態: 未監視"
                : calibrated
                ? `状態: ${status === "ok" ? "良好" : status === "未検出" ? "未検出（離席中？）" : status}`
                : "未キャリブレーション"}
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

            {/* カメラ停止中オーバーレイ：停止中は映像エリア全体を暗くして「停止中」を表示 */}
            {!cameraActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-3">
                <span className="text-4xl text-red-400 animate-pulse">●</span>
                <p className="text-sm font-bold text-slate-200">カメラ停止中</p>
                <p className="text-xs text-slate-400">他のアプリでカメラを使えます</p>
              </div>
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
                        : status === "未検出"
                        ? "bg-amber-400"
                        : "bg-red-500 animate-pulse"
                    }`}
                  />
                  <span className="truncate font-medium">
                    {!cameraActive ? "未監視" : calibrated ? (status === "ok" ? "姿勢OK" : status === "未検出" ? "離席中?" : status) : "未キャリブレーション"}
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

          {/* Start/Stop ボタン */}
          <div className="flex justify-center pt-1">
            {!isStarted ? (
              <button
                onClick={() => setIsStarted(true)}
                className="px-10 py-3 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-900 font-bold text-base shadow-lg hover:opacity-90 active:scale-95 transition-transform"
              >
                ▶ 監視を開始
              </button>
            ) : (
              <button
                onClick={handleStop}
                className="px-10 py-3 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 font-bold text-base shadow-lg hover:bg-red-500/30 active:scale-95 transition"
              >
                ■ 監視を停止
              </button>
            )}
          </div>

          {/* 使い方ヒント */}
          <div className="text-xs text-slate-400 px-1">
            正しい姿勢で座って <span className="text-slate-200 font-semibold">「姿勢を記録」</span> を押すと基準が登録されます。開始後、崩れが5秒続くと通知されます。
          </div>
        </section>

        {/* ── 右：サイドパネル ── */}
        <aside className="space-y-4">
          {/* ① 今日の崩れカード（常に表示） */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-bold">今日の崩れ</h2>
              <span className="text-xs text-slate-400">{todayKey()}</span>
            </div>
            <div className="flex items-baseline gap-4 mb-3">
              <div className="text-4xl font-bold">
                {totalIssues}
                <span className="text-sm font-normal text-slate-400 ml-1">回</span>
              </div>
              <div className="text-xs text-slate-400">
                動作 <span className="text-slate-200 font-semibold">{formatHm(todayRecord.uptimeMs)}</span>
                {todayRecord.uptimeMs > 0 && (
                  <span className="ml-2">
                    （<span className="text-slate-200 font-semibold">
                      {(totalIssues / (todayRecord.uptimeMs / 3_600_000)).toFixed(1)}
                    </span>
                    <span className="text-slate-400">回/時</span>）
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1.5 text-sm">
              <StatRow label="うつむき" value={todayRecord.count["うつむき"]} color="bg-amber-400" />
              <StatRow label="前のめり" value={todayRecord.count["前のめり"]} color="bg-pink-400" />
              <StatRow label="肩崩れ" value={todayRecord.count["肩崩れ"]} color="bg-cyan-400" />
            </div>
            <button
              onClick={() =>
                setHistory((prev) => ({ ...prev, [todayKey()]: emptyDailyRecord() }))
              }
              className="mt-4 text-xs text-slate-400 hover:text-slate-200 transition"
            >
              今日をリセット
            </button>
          </div>

          {/* ② 設定カード */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 space-y-3">
            <h2 className="font-bold mb-1">設定</h2>

            <ToggleRow
              label="アラート音"
              checked={settings.soundEnabled}
              onChange={(v) => setSettings((s) => ({ ...s, soundEnabled: v }))}
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

          {/* ③ 履歴カード（折り畳み式）
              ヘッダー全体をボタンにして、クリックで open/close を切り替える */}
          <div className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden">
            {/* 折り畳みヘッダー：▶ / ▼ で開閉状態を示す */}
            <button
              onClick={() => setHistoryOpen((prev) => !prev)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition text-left"
            >
              <h2 className="font-bold">履歴</h2>
              {/* 三角を rotate で回す：closed=右向き(▶) / open=下向き(▼) */}
              <span
                className={`text-slate-400 transition-transform duration-200 ${
                  historyOpen ? "rotate-90" : ""
                }`}
              >
                ▶
              </span>
            </button>

            {/* 折り畳みコンテンツ：historyOpen が true のときだけ表示 */}
            {historyOpen && (
              <div className="px-5 pb-5 space-y-3">
                {/* 期間切替 */}
                <div className="flex gap-1 rounded-lg bg-black/30 p-0.5">
                  {(["7days", "30days", "90days", "all"] as Period[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setHistoryPeriod(p)}
                      className={`flex-1 text-[10px] px-2 py-1 rounded-md transition ${
                        historyPeriod === p
                          ? "bg-white text-slate-900 font-bold"
                          : "text-slate-300 hover:bg-white/10"
                      }`}
                    >
                      {PERIOD_LABELS[p]}
                    </button>
                  ))}
                </div>

                {/* サマリ */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-black/30 p-2">
                    <div className="text-[10px] text-slate-400">合計</div>
                    <div className="font-bold text-slate-100 tabular-nums">
                      {periodTotalCount}<span className="text-[10px] text-slate-400 ml-0.5">回</span>
                    </div>
                  </div>
                  <div className="rounded-lg bg-black/30 p-2">
                    <div className="text-[10px] text-slate-400">動作時間</div>
                    <div className="font-bold text-slate-100 tabular-nums">
                      {formatHm(periodTotalHours * 3_600_000)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-black/30 p-2">
                    <div className="text-[10px] text-slate-400">崩れ率</div>
                    <div className="font-bold text-slate-100 tabular-nums">
                      {periodAvgRate.toFixed(1)}<span className="text-[10px] text-slate-400 ml-0.5">回/時</span>
                    </div>
                  </div>
                </div>

                {/* 棒グラフ */}
                <div className="w-full h-48">
                  {chartData.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-xs text-slate-500">
                      まだ履歴がありません
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                        <XAxis
                          dataKey="label"
                          tick={{ fill: "#94a3b8", fontSize: 10 }}
                          interval="preserveStartEnd"
                        />
                        <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
                        <Tooltip
                          contentStyle={{
                            background: "#0f172a",
                            border: "1px solid #334155",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelStyle={{ color: "#e2e8f0" }}
                          formatter={(value, _name, item) => {
                            const row = (item as { payload?: ChartRow }).payload;
                            if (!row) return [String(value), "回/時"];
                            return [
                              `${row.rate.toFixed(1)}回/時（合計${row.total}回 / ${formatHm(row.uptimeHours * 3_600_000)}）`,
                              "崩れ率",
                            ];
                          }}
                        />
                        <Bar dataKey="rate" fill="#34d399" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="text-[10px] text-slate-500">
                  縦軸: 1時間あたりの崩れ回数（動作時間で正規化）
                </div>
              </div>
            )}
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
