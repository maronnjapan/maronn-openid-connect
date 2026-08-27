/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next.js 16 の型チェックは TypeScript の compiler API を直接叩くが、
    // その API は TypeScript 7 で作り直されており `next build` が
    // 「TypeScript 7.x does not provide the compiler API required by Next.js」
    // で止まる。tsc を CLI として呼ぶこの経路なら 7 系でも通る。
    useTypeScriptCli: true,
  },
};

export default nextConfig;
