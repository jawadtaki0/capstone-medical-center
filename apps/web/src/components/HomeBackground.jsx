import { useEffect, useRef } from "react";

// Geometry and colour stay fixed; only the motion phase/pacing varies per mount.
export default function HomeBackground() {
  const root = useRef(null);
  const motion = useRef(null);
  useEffect(() => {
    const node = root.current;
    const svg = node.querySelector("svg");
    const scrollLayers = [...node.querySelectorAll(".home-background-scroll")];
    const ambientLayers = [
      ...node.querySelectorAll(".home-background-ambient"),
    ];
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!motion.current)
      motion.current = Array.from({ length: 3 }, () => ({
        phase: Array.from({ length: 4 }, () => Math.random() * Math.PI * 2),
        pace: 0.92 + Math.random() * 0.16,
      }));
    let frame = null,
      lastTime = null,
      elapsed = 0;
    let disposed = false;
    let visible = true,
      targetScroll = 0,
      currentScroll = 0;
    let pageTop = 0,
      scaleX = 1,
      scaleY = 1;
    const amplitude = [
      [18, 16],
      [48, 42],
      [36, 34],
    ];
    const periods = [
      [31, 47, 37, 59],
      [23, 41, 29, 53],
      [19, 37, 31, 43],
    ];
    function measure() {
      const box = svg.getBoundingClientRect();
      pageTop = box.top + window.scrollY;
      scaleX = Math.max(box.width / 1440, 0.01);
      scaleY = Math.max(box.height / 2400, 0.01);
      onScroll();
    }
    function onScroll() {
      targetScroll = Math.max(0, window.scrollY - pageTop);
    }
    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      lastTime = null;
      node.dataset.motion = "paused";
    }
    function tick(now) {
      if (disposed) return;
      const delta = lastTime === null ? 0 : Math.min(now - lastTime, 64);
      lastTime = now;
      elapsed += delta / 1000;
      currentScroll +=
        (targetScroll - currentScroll) * (1 - Math.exp(-delta / 100));
      const depth = [
        [
          -Math.min(currentScroll * 0.015, 32),
          Math.min(currentScroll * 0.035, 80),
        ],
        [
          Math.min(currentScroll * 0.04, 110),
          -Math.min(currentScroll * 0.1, 180),
        ],
        [
          -Math.min(currentScroll * 0.035, 96),
          Math.min(currentScroll * 0.065, 150),
        ],
      ];
      motion.current.forEach(({ phase, pace }, i) => {
        const t = elapsed * pace * Math.PI * 2;
        const [a, b, c, d] = periods[i];
        const x =
          amplitude[i][0] *
          (0.62 * Math.sin(t / a + phase[0]) +
            0.38 * Math.sin(t / b + phase[1]));
        const y =
          amplitude[i][1] *
          (0.6 * Math.cos(t / c + phase[2]) + 0.4 * Math.sin(t / d + phase[3]));
        scrollLayers[i].style.transform =
          `translate(${depth[i][0] / scaleX}px, ${depth[i][1] / scaleY}px)`;
        ambientLayers[i].style.transform =
          `translate(${x / scaleX}px, ${y / scaleY}px)`;
      });
      frame = requestAnimationFrame(tick);
    }
    function synchronize() {
      if (disposed) return;
      if (preference.matches || document.hidden || !visible) {
        stop();
        return;
      }
      if (frame === null) {
        node.dataset.motion = "running";
        frame = requestAnimationFrame(tick);
      }
    }
    const observer =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            synchronize();
          })
        : null;
    const resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    resize?.observe(node);
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measure);
    document.addEventListener("visibilitychange", synchronize);
    preference.addEventListener("change", synchronize);
    synchronize();
    return () => {
      disposed = true;
      stop();
      observer?.disconnect();
      resize?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measure);
      document.removeEventListener("visibilitychange", synchronize);
      preference.removeEventListener("change", synchronize);
    };
  }, []);
  return (
    <div className="home-background" aria-hidden="true" ref={root}>
      <svg viewBox="0 0 1440 2400" preserveAspectRatio="none" focusable="false">
        <g className="home-background-scroll">
          <g className="home-background-ambient">
            <path
              className="home-background-surface"
              d="M0 -100H1040C900 180 1070 480 880 740S510 1090 660 1410S850 1810 440 2500H0Z"
            />
          </g>
        </g>
        <g className="home-background-scroll">
          <g className="home-background-ambient">
            <path
              className="home-background-ribbon"
              d="M-500 -120C-260 -100 460 40 160 300S-80 660 240 960S620 1500 180 2010S-60 2380 320 2600"
            />
          </g>
        </g>
        <g className="home-background-scroll">
          <g className="home-background-ambient">
            <path
              className="home-background-fold"
              d="M-210 640C130 480 190 1010 530 1230S860 1780 250 2480"
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
