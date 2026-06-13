/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Type-safety is enforced separately via `tsc --noEmit`; don't let lint warnings
  // on the ported product surfaces block production builds.
  eslint: { ignoreDuringBuilds: true },
  // RainbowKit / wagmi pull in optional WalletConnect deps that Next tries to bundle.
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // MetaMask SDK optionally imports React-Native async storage; stub it in web builds.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;
