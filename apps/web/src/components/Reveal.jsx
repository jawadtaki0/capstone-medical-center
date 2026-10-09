import { useLayoutEffect, useRef, useState } from "react";

export default function Reveal({
  children,
  className = "",
  direction = "up",
  delay = 0,
}) {
  const element = useRef(null);
  const observer = useRef(null);
  const revealed = useRef(false);
  const [state, setState] = useState("visible");
  const [instant, setInstant] = useState(false);

  function show(immediately = false) {
    if (revealed.current) return;
    revealed.current = true;
    observer.current?.disconnect();
    observer.current = null;
    if (immediately) setInstant(true);
    setState("visible");
  }

  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const node = element.current;
    if (
      !node ||
      motion.matches ||
      !("IntersectionObserver" in window) ||
      node.getBoundingClientRect().top < window.innerHeight - 24
    ) {
      show();
      return;
    }

    setState("pending");
    observer.current = new IntersectionObserver(
      ([entry]) => {
        // A fast scroll can jump completely past an element between observer updates.
        if (entry.isIntersecting || entry.boundingClientRect.bottom < 0) show();
      },
      { rootMargin: "0px 0px -24px 0px", threshold: 0.01 },
    );
    observer.current.observe(node);
    const onMotionChange = () => {
      if (motion.matches) show();
    };
    motion.addEventListener("change", onMotionChange);
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      motion.removeEventListener("change", onMotionChange);
    };
  }, []);

  return (
    <div
      ref={element}
      className={`reveal reveal-${state} ${instant ? "reveal-instant" : ""} ${className}`}
      data-direction={direction}
      style={{ "--reveal-delay": `${delay}ms` }}
      onFocusCapture={() => show(true)}
    >
      {children}
    </div>
  );
}
