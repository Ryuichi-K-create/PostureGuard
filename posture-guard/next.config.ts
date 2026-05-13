import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack(Next.js 16標準バンドラ)の設定
  turbopack: {
    // ファイルシステムのrootを明示。親ディレクトリに.gitがある構成だと
    // Next.jsの自動判定が誤動作してTailwindCSSが解決できなくなる。
    //
    // 当初は __dirname を使ったが効果なし。理由はNext.jsが next.config.ts を
    // 内部でトランスパイルして実行するため、__dirname がトランスパイル後の
    // 場所を指してしまい、Turbopackのrootが意図しない場所に設定されていたから。
    //
    // process.cwd() = `npm run dev` を実行したディレクトリ = posture-guard/。
    // こちらはトランスパイル先に影響されず常に正しい値が取れる。
    // process.cwd() も __dirname も Next.js 内部での評価で意図と違う値になるため、
    // 絶対パスをハードコード。可搬性は犠牲だが、開発機が固定なので許容する。
    // 後で別マシンに移したら以下のパスを書き換えればOK。
    root: "C:\\Users\\Scent\\Project\\PostureGuard\\posture-guard",
  },
};

export default nextConfig;
