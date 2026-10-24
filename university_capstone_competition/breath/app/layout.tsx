import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "숨결톡톡 | 흉벽 진동 제어",
  description: "Bluetooth 2채널 진동과 ESP32 센서 측정 대시보드",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
