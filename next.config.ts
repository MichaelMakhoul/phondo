import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js dev mode uses eval() for source maps — 'unsafe-eval' is only added in development
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://js.stripe.com https://cdn.jsdelivr.net https://www.googletagmanager.com`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://*.supabase.co https://api.dicebear.com https://www.google-analytics.com",
      `connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://api.vapi.ai https://api.elevenlabs.io https://api.cal.com wss://*.fly.dev https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com${isDev ? " ws://localhost:* wss://localhost:*" : ""}`,
      "worker-src 'self' blob:",
      "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
      "media-src 'self' blob: https://*.supabase.co",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async redirects() {
    return [
      {
        source: "/settings/calendar",
        destination: "/settings/scheduling",
        permanent: true,
      },
    ];
  },
};

export default withSentryConfig(nextConfig, { silent: true, disableLogger: true });
