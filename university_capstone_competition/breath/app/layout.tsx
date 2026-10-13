import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "숨결톡톡 | 흉벽 진동 제어",
  description: "ESP32 BLE 기반 흉벽 진동 제어 대시보드",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
