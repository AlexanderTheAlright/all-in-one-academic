/* App brand mark: the faceted violet mountain-gem (reads as an "A": peak +
 * crossbar band + negative V-notch base). Inlined so the bundle carries no
 * external asset; gradient ids are namespaced (am-) to avoid any clash with
 * other inline SVGs on the page. Standalone asset: docs/logo.svg. */
export function AppMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={className}
      viewBox="238 230 548 550"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <radialGradient id="am-inner" cx="0.5" cy="0.42" r="0.6">
          <stop offset="0" stopColor="#C4B5FD" stopOpacity="0.08" />
          <stop offset="1" stopColor="#C4B5FD" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="am-gU1" gradientUnits="userSpaceOnUse" x1="0" y1="560" x2="0" y2="238"><stop offset="0" stopColor="#8B6DF8" /><stop offset="1" stopColor="#5636C4" /></linearGradient>
        <linearGradient id="am-gU2" gradientUnits="userSpaceOnUse" x1="0" y1="560" x2="0" y2="238"><stop offset="0" stopColor="#7C5CFF" /><stop offset="1" stopColor="#4C2AAE" /></linearGradient>
        <linearGradient id="am-gU3" gradientUnits="userSpaceOnUse" x1="0" y1="560" x2="0" y2="238"><stop offset="0" stopColor="#5B3FD6" /><stop offset="1" stopColor="#3A1E8E" /></linearGradient>
        <linearGradient id="am-gU4" gradientUnits="userSpaceOnUse" x1="0" y1="560" x2="0" y2="238"><stop offset="0" stopColor="#4930B8" /><stop offset="1" stopColor="#2E1570" /></linearGradient>
        <linearGradient id="am-gD1" gradientUnits="userSpaceOnUse" x1="0" y1="772" x2="0" y2="616"><stop offset="0" stopColor="#8B6DF8" /><stop offset="1" stopColor="#A78BFA" /></linearGradient>
        <linearGradient id="am-gD2" gradientUnits="userSpaceOnUse" x1="0" y1="772" x2="0" y2="616"><stop offset="0" stopColor="#7C5CFF" /><stop offset="1" stopColor="#9174F4" /></linearGradient>
        <linearGradient id="am-gD3" gradientUnits="userSpaceOnUse" x1="0" y1="772" x2="0" y2="616"><stop offset="0" stopColor="#5A3DC8" /><stop offset="1" stopColor="#6A4EDD" /></linearGradient>
        <linearGradient id="am-gD4" gradientUnits="userSpaceOnUse" x1="0" y1="772" x2="0" y2="616"><stop offset="0" stopColor="#472BA6" /><stop offset="1" stopColor="#5638BE" /></linearGradient>
        <linearGradient id="am-rim" gradientUnits="userSpaceOnUse" x1="512" y1="238" x2="246" y2="772">
          <stop offset="0" stopColor="#F0EBFF" stopOpacity="0.85" /><stop offset="0.4" stopColor="#C4B5FD" stopOpacity="0.4" /><stop offset="1" stopColor="#C4B5FD" stopOpacity="0" />
        </linearGradient>
        <clipPath id="am-sil"><polygon points="512,238 246,772 778,772" /></clipPath>
      </defs>
      <polygon points="512,238 352,560 440,560" fill="url(#am-gU1)" />
      <polygon points="512,238 440,560 534,560" fill="url(#am-gU2)" />
      <polygon points="512,238 534,560 606,560" fill="url(#am-gU3)" />
      <polygon points="512,238 606,560 672,560" fill="url(#am-gU4)" />
      <polygon points="352,560 440,560 427,616 324,616" fill="#CDBFFF" />
      <polygon points="440,560 534,560 538,616 427,616" fill="#AE97FC" />
      <polygon points="534,560 606,560 622,616 538,616" fill="#8E70F0" />
      <polygon points="606,560 672,560 700,616 622,616" fill="#7458DE" />
      <polygon points="324,616 427,616 392,772 246,772" fill="url(#am-gD1)" />
      <polygon points="427,616 538,616 548,772 512,682 470,772 392,772" fill="url(#am-gD2)" />
      <polygon points="538,616 622,616 668,772 548,772" fill="url(#am-gD3)" />
      <polygon points="622,616 700,616 778,772 668,772" fill="url(#am-gD4)" />
      <line x1="512" y1="682" x2="548" y2="772" stroke="#A78BFA" strokeOpacity="0.35" strokeWidth="2" />
      <polygon points="512,238 439,384 486,354" fill="#3A1678" />
      <polygon points="512,238 486,354 523,396" fill="#160E2E" />
      <polygon points="512,238 523,396 548,360" fill="#2B1157" />
      <polygon points="512,238 548,360 583,380" fill="#22104A" />
      <ellipse cx="512" cy="430" rx="270" ry="290" fill="url(#am-inner)" clipPath="url(#am-sil)" />
      <line x1="352" y1="560" x2="672" y2="560" stroke="#E9E2FF" strokeOpacity="0.3" strokeWidth="1.5" />
      <line x1="512" y1="238" x2="246" y2="772" stroke="url(#am-rim)" strokeWidth="2.5" />
      <polygon points="512,242 484,300 501,316" fill="#E9E2FF" opacity="0.9" />
    </svg>
  );
}
