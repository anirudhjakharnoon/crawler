/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    dirs: ["app", "lib", "components"],
  },
  // puppeteer-core + @sparticuz/chromium (lib/render.ts, the opt-in
  // JS-rendering fallback) ship native binaries/dynamic requires that
  // Next's default webpack bundling for Server Components can't trace
  // correctly. Marking them external keeps them as plain node_modules
  // requires in the serverless function bundle instead of trying (and
  // failing) to bundle them.
  experimental: {
    serverComponentsExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
    // Vercel's output file tracing doesn't automatically discover
    // @sparticuz/chromium's bundled Chromium binary (it's resolved via a
    // runtime fs path, not a static import), so it has to be listed
    // explicitly here or the deployed function will fail at runtime with
    // "chromium binary not found" the first time rendering is attempted.
    outputFileTracingIncludes: {
      "/api/jobs/[id]/tick": ["./node_modules/@sparticuz/chromium/**"],
    },
  },
};

module.exports = nextConfig;
