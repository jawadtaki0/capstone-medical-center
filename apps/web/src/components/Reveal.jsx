import { useEffect, useRef, useState } from "react";
export default function Reveal({ children, className = "" }) {
  const element = useRef(null);
  const [state, setState] = useState("visible");
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || !("IntersectionObserver" in window)) return;
    if (element.current.getBoundingClientRect().top < window.innerHeight) return;
    setState("pending");
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setState("visible"); observer.disconnect(); }
    }, { threshold: 0.08 });
    observer.observe(element.current);
    const disable = () => { if (motion.matches) { setState("visible"); observer.disconnect(); } };
    motion.addEventListener("change", disable);
    return () => { observer.disconnect(); motion.removeEventListener("change", disable); };
  }, []);
  return <div ref={element} className={`reveal reveal-${state} ${className}`} onFocusCapture={() => setState("visible")}>{children}</div>;
}
