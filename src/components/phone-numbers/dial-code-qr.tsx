"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { telHref } from "@/lib/country-config/forwarding";

/**
 * SCRUM-529: a QR of the `tel:` URI, so the dial code can cross the
 * laptop-to-handset gap. The tap-to-dial button only exists on a phone
 * (`sm:hidden`); on a desktop the owner was left hand-transcribing a
 * 14-character MMI string where one wrong key fails silently — the carrier
 * plays its confirmation tone either way (SCRUM-516). Scanning the code
 * with the phone's camera opens the dialer with the code already entered;
 * no handset auto-dials from a link, the owner still presses call.
 *
 * Rendered as plain JSX rects from the module matrix — no innerHTML, no
 * library-generated markup. The payload is gated by telHref (dial-code
 * characters only); anything else renders nothing.
 */
export function DialCodeQr({ code, className }: { code: string; className?: string }) {
  const matrix = useMemo(() => {
    const href = telHref(code);
    if (!href) return null;
    try {
      // Type 0 = auto-size; "M" error correction is plenty for a short URI.
      const qr = qrcode(0, "M");
      qr.addData(href);
      qr.make();
      const count = qr.getModuleCount();
      const dark: Array<[number, number]> = [];
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) dark.push([r, c]);
        }
      }
      return { count, dark };
    } catch {
      // A payload the library refuses is a payload we don't render.
      return null;
    }
  }, [code]);

  if (!matrix) return null;

  const QUIET_ZONE = 4; // modules of white border — ISO/IEC 18004 minimum
  const size = matrix.count + QUIET_ZONE * 2;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`QR code: scan with your phone to dial ${code}`}
      className={className}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      {matrix.dark.map(([r, c]) => (
        <rect key={`${r}-${c}`} x={c + QUIET_ZONE} y={r + QUIET_ZONE} width={1} height={1} fill="#000000" />
      ))}
    </svg>
  );
}
