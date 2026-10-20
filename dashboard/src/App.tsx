import { useMemo, useState } from "react";

/* ---------- thin line icons (stroke only, 1.5px) ---------- */

type IconProps = { className?: string; stroke?: string };

const base = (className?: string) =>
  `h-5 w-5 shrink-0 ${className ?? ""}`; // 20px default glyph box

function PlusIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <path d="M12 5v14M5 12h14" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke={stroke} strokeWidth="1.5" />
      <path d="m16 16 4.5 4.5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CompassIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke={stroke} strokeWidth="1.5" />
      <path
        d="m14.8 9.2-1.6 4.0-4.0 1.6 1.6-4.0z"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GridIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" stroke={stroke} strokeWidth="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" stroke={stroke} strokeWidth="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" stroke={stroke} strokeWidth="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

function ClockIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke={stroke} strokeWidth="1.5" />
      <path d="M12 7.5V12l3 2" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <path d="m6 9 6 6 6-6" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkIcon({ className, stroke = "currentColor" }: IconProps) {
  // 4-point sparkle
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <path
        d="M12 3.5 13.8 9.2 19.5 11 13.8 12.8 12 18.5 10.2 12.8 4.5 11 10.2 9.2z"
        fill={stroke}
      />
    </svg>
  );
}

function GearIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 ${className ?? ""}`} aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke={stroke} strokeWidth="1.5" />
      <path
        d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M17.3 6.7l-1.4 1.4M8.1 15.9l-1.4 1.4"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={base(className)} aria-hidden>
      <rect x="9.5" y="4" width="5" height="10" rx="2.5" stroke={stroke} strokeWidth="1.5" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlaneIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4.5 w-4.5 ${className ?? ""}`} aria-hidden>
      <path
        d="M4.5 11.2 19 5.5c.6-.2 1.1.3 1 .9l-2.8 12c-.1.6-.9.8-1.3.3l-3.2-4.1-4.5-1.7c-.6-.2-.6-1.1.1-1.3l7.2-2.8"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AtomIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 ${className ?? ""}`} aria-hidden>
      <circle cx="12" cy="12" r="1.4" fill={stroke} />
      <ellipse cx="12" cy="12" rx="8" ry="3.4" stroke={stroke} strokeWidth="1.4" />
      <ellipse cx="12" cy="12" rx="8" ry="3.4" stroke={stroke} strokeWidth="1.4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="8" ry="3.4" stroke={stroke} strokeWidth="1.4" transform="rotate(120 12 12)" />
    </svg>
  );
}

function FrameIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 ${className ?? ""}`} aria-hidden>
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke={stroke} strokeWidth="1.5" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

function NoteIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 ${className ?? ""}`} aria-hidden>
      <path d="M9.5 17.5V6.2l9-1.7v11" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7.2" cy="17.5" r="2.3" stroke={stroke} strokeWidth="1.5" />
      <circle cx="16.2" cy="15.5" r="2.3" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

function DotsIcon({ className, stroke = "currentColor" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 ${className ?? ""}`} aria-hidden>
      <circle cx="6" cy="12" r="1.4" fill={stroke} />
      <circle cx="12" cy="12" r="1.4" fill={stroke} />
      <circle cx="18" cy="12" r="1.4" fill={stroke} />
    </svg>
  );
}

/* ---------- colorful service icons (the only color in the palette) ---------- */

function LayersIcon() {
  // orange stacked layers
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden>
      <path d="M16 6 27 11.5 16 17 5 11.5z" fill="#F5A623" />
      <path d="M5 15.5 16 21l11-5.5-3.2-1.6L16 17.8 8.2 14z" fill="#F08C1B" />
      <path d="M5 19.5 16 25l11-5.5-3.2-1.6L16 21.8 8.2 18z" fill="#E27A0F" />
    </svg>
  );
}

function CollabIcon() {
  // multicolor collaboration-app mark (hash-style four bars)
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden>
      <rect x="7" y="13.5" width="4" height="10" rx="2" fill="#36C5F0" transform="rotate(-14 9 18.5)" />
      <rect x="14" y="8.5" width="4" height="10" rx="2" fill="#2EB67D" transform="rotate(-14 16 13.5)" />
      <rect x="14" y="21" width="4" height="9" rx="2" fill="#ECB22E" transform="rotate(14 16 25.5)" />
      <rect x="21" y="13.5" width="4" height="10" rx="2" fill="#E01E5A" transform="rotate(14 23 18.5)" />
    </svg>
  );
}

function CalendarIcon() {
  // calendar tile showing a blue 31
  return (
    <svg viewBox="0 0 32 32" className="h-9 w-9" aria-hidden>
      <rect x="5" y="7" width="22" height="20" rx="3" fill="#fff" stroke="#DDE3F0" />
      <path d="M5 10a3 3 0 0 1 3-3h16a3 3 0 0 1 3 3v3H5z" fill="#1A73E8" />
      <text
        x="16"
        y="25.5"
        textAnchor="middle"
        fontFamily="Inter, sans-serif"
        fontWeight="700"
        fontSize="11.5"
        fill="#1A73E8"
      >
        31
      </text>
    </svg>
  );
}

/* ---------- mascot ---------- */

function Robot() {
  return (
    <svg viewBox="0 0 150 170" className="h-40 w-auto" aria-hidden>
      {/* arms peeking over the panel edge */}
      <path d="M28 130c-8-10-8-24-2-30l14 8c-2 8-2 16 0 22z" fill="#E8EBF2" stroke="#D5DAE6" />
      <path d="M122 130c8-10 8-24 2-30l-14 8c2 8 2 16 0 22z" fill="#E8EBF2" stroke="#D5DAE6" />
      {/* head */}
      <rect x="35" y="38" width="80" height="66" rx="20" fill="#F8FAFD" stroke="#DDE2EC" />
      {/* visor */}
      <rect x="47" y="56" width="56" height="26" rx="12" fill="#10141F" />
      {/* glowing cyan eyes */}
      <circle cx="62" cy="69" r="5" fill="#3DDCFF">
        <animate attributeName="opacity" values="1;0.55;1" dur="2.6s" repeatCount="indefinite" />
      </circle>
      <circle cx="88" cy="69" r="5" fill="#3DDCFF">
        <animate attributeName="opacity" values="0.55;1;0.55" dur="2.6s" repeatCount="indefinite" />
      </circle>
      {/* smile */}
      <path d="M68 92c3.5 4 10.5 4 14 0" stroke="#1C2233" strokeWidth="3" strokeLinecap="round" fill="none" />
      {/* antenna */}
      <path d="M75 38v-8" stroke="#D5DAE6" strokeWidth="3" strokeLinecap="round" />
      <circle cx="75" cy="26" r="4" fill="#3DDCFF" opacity="0.9" />
      {/* body peeking below */}
      <rect x="46" y="104" width="58" height="30" rx="14" fill="#F8FAFD" stroke="#DDE2EC" />
      <circle cx="63" cy="119" r="4.5" fill="#E4E8F1" />
      <circle cx="87" cy="119" r="4.5" fill="#E4E8F1" />
    </svg>
  );
}

/* ---------- data ---------- */

const chips = [
  { label: "Deep Research", icon: AtomIcon },
  { label: "Make an Image", icon: FrameIcon },
  { label: "Search", icon: SearchIcon },
  { label: "Create music", icon: NoteIcon },
] as const;

const railButtons = [SearchIcon, CompassIcon, GridIcon, ClockIcon] as const;

/* ---------- app ---------- */

export default function App() {
  const [value, setValue] = useState("");
  const canSend = value.trim().length > 0;

  const focusRing = useMemo(
    () => "focus-within:ring-[3px] focus-within:ring-ring/60 focus-within:border-hairline",
    [],
  );

  return (
    <div
      className="min-h-dvh w-full"
      style={{ background: "linear-gradient(135deg,#DCD8F2 0%,#E8E4F5 45%,#F2EFE9 100%)" }}
    >
      {/* mobile: column (rail becomes bottom bar via flex order) / desktop: row */}
      <div className="flex min-h-dvh flex-col md:flex-row">
        {/* ===== icon rail ===== */}
        <nav className="order-2 flex shrink-0 items-center justify-center gap-2 bg-[#E4E0F6]/70 px-3 py-2 md:order-1 md:h-dvh md:w-[72px] md:flex-col md:justify-start md:gap-3 md:py-5 md:bg-[#E4E0F6]">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white shadow-sm transition-colors hover:bg-[#22283A] active:scale-97"
            aria-label="New chat"
          >
            <PlusIcon className="h-4.5 w-4.5" />
          </button>
          {railButtons.map((Icon, i) => (
            <button
              key={i}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-hairline bg-white text-ink-soft shadow-[0_1px_3px_rgba(60,50,110,0.08)] transition-colors hover:text-ink active:scale-97"
              aria-label={["Search", "Explore", "Apps", "History"][i]}
            >
              <Icon className="h-4.5 w-4.5" />
            </button>
          ))}
          {/* logo pinned to bottom (rail) / pushed right cluster (mobile keeps order) */}
          <div className="ml-auto md:ml-0 md:mt-auto">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
                <path
                  d="M12 3.5c4.5 0 7.5 2.6 7.5 6.9 0 4.6-3 8.1-7.5 9.1-4.5-1-7.5-4.5-7.5-9.1C4.5 6.1 7.5 3.5 12 3.5z"
                  fill="currentColor"
                  opacity="0.25"
                />
                <path d="M8.5 13.6c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" fill="none" />
                <circle cx="9.4" cy="9.6" r="1.2" fill="currentColor" />
                <circle cx="14.6" cy="9.6" r="1.2" fill="currentColor" />
              </svg>
            </div>
          </div>
        </nav>

        {/* ===== floating main panel ===== */}
        <main className="order-1 flex-1 p-4 pb-2 md:order-2 md:p-4">
          <section
            className={`panel-enter panel-glow relative flex h-full min-h-[560px] flex-col overflow-hidden rounded-[28px] border border-white/60 bg-white/92 p-6 md:p-9 backdrop-blur-xl shadow-[0_20px_60px_rgba(60,50,110,0.12)]`}
          >
            {/* ===== top bar ===== */}
            <header className="flex items-center justify-between gap-3">
              <button className="flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-2 text-[13px] font-medium text-ink transition-colors hover:bg-hairline/60">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-hairline/70 text-ink-soft">
                  <GearIcon />
                </span>
                Assistant v2.6
                <ChevronDownIcon className="h-3.5 w-3.5 text-muted" />
              </button>
              <span className="hidden truncate text-[13px] text-muted sm:block">Daily Nixtio</span>
              <button className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#22283A] active:scale-97">
                <SparkIcon className="h-3.5 w-3.5" />
                Upgrade
              </button>
            </header>

            {/* ===== hero + mascot ===== */}
            <div className="relative mt-10 md:mt-14 md:pb-4 md:pt-8">
              <h1 className="max-w-[520px] text-3xl font-semibold leading-[1.1] tracking-[-0.03em] text-ink sm:text-4xl md:text-[44px]">
                Hi Nixtio, Ready to Achieve Great Things?
              </h1>

              {/* mascot cluster: peeks in at the hero's top-right, below the upgrade pill */}
              <div className="pointer-events-none absolute -top-6 right-2 hidden select-none md:block">
                <div className="relative">
                  {/* speech bubble, left of and slightly above the robot */}
                  <div className="absolute -left-36 top-0 z-10 w-max rounded-2xl border border-hairline bg-white px-3.5 py-2 shadow-[0_10px_30px_rgba(60,50,110,0.10)]">
                    <p className="text-[12.5px] font-medium text-ink">
                      Hey there! <span aria-hidden>👋</span>
                      <span className="block">Need a boost?</span>
                    </p>
                  </div>
                  <div className="relative z-0 mt-6">
                    <Robot />
                  </div>
                </div>
              </div>
            </div>

            {/* ===== feature triad ===== */}
            <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-1 md:mt-12 md:grid-cols-3">
              <FeatureCard
                icon={<LayersIcon />}
                body="Contribute ideas, offer feedback, and manage tasks — all in sync."
                label="Fast Start"
              />
              <FeatureCard
                icon={<CollabIcon />}
                body="Stay connected, share ideas, and align goals effortlessly. Boost your productivity with AI Bot"
                label="Collaborate with Team"
              />
              <FeatureCard
                icon={<CalendarIcon />}
                body="Organize your time efficiently, set clear priorities, and stay focused"
                label="Planning"
              />
            </div>

            {/* ===== composer pinned near bottom ===== */}
            <div className="mt-auto pt-10">
              <div className="rounded-[20px] border border-hairline bg-white shadow-[0_4px_20px_rgba(60,50,110,0.06)]">
                {/* micro-label row */}
                <div className="flex items-center justify-between px-4 pt-3 text-[11px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <SparkIcon className="h-3 w-3" stroke="#8A8F9E" />
                    Unlock more with Pro Plan
                  </span>
                  <span className="flex items-center gap-1.5">
                    <GearIcon className="h-3 w-3" stroke="#8A8F9E" />
                    Powered by Assistant v2.6
                  </span>
                </div>

                {/* input row */}
                <form
                  className={`mt-2 mx-2 flex items-center gap-2 rounded-2xl border border-transparent px-2 py-2 transition-shadow ${focusRing}`}
                  onSubmit={(e) => e.preventDefault()}
                >
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-hairline/60 hover:text-ink-soft"
                    aria-label="Add attachment"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                  <input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder='Example : "Explain quantum computing in simple terms"'
                    className="h-8 min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted"
                  />
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-hairline/60 hover:text-ink-soft"
                    aria-label="Voice input"
                  >
                    <MicIcon className="h-4.5 w-4.5" />
                  </button>
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-white transition-all duration-150 enabled:hover:bg-[#22283A] disabled:opacity-40"
                    aria-label="Send message"
                  >
                    <PlaneIcon />
                  </button>
                </form>

                {/* chip row */}
                <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-3">
                  {chips.map(({ label, icon: Icon }) => (
                    <button
                      key={label}
                      className="flex h-7 items-center gap-1.5 rounded-full bg-ink px-3 text-[12.5px] font-medium text-white transition-all duration-150 hover:bg-[#22283A] active:scale-97"
                    >
                      <Icon stroke="currentColor" />
                      {label}
                    </button>
                  ))}
                  <button
                    className="flex h-7 w-8 items-center justify-center rounded-full bg-ink text-white transition-all duration-150 hover:bg-[#22283A] active:scale-97"
                    aria-label="More options"
                  >
                    <DotsIcon />
                  </button>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function FeatureCard({
  icon,
  body,
  label,
}: {
  icon: React.ReactNode;
  body: string;
  label: string;
}) {
  return (
    <article className="rounded-2xl border border-hairline bg-white p-6 shadow-[0_4px_20px_rgba(60,50,110,0.06)] transition-all duration-[180ms] ease-out hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(60,50,110,0.12)]">
      <div className="mb-6">{icon}</div>
      <p className="text-[15px] leading-relaxed text-ink-soft">{body}</p>
      <p className="mt-4 text-[12px] font-medium text-muted">{label}</p>
    </article>
  );
}
