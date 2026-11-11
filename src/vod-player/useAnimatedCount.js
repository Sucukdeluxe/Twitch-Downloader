import { useLayoutEffect, useRef, useState } from "react";

export function useAnimatedCount(target, { duration = 240, precision = 0 } = {}) {
  const [displayed, setDisplayed] = useState(target);
  const current = useRef(target);

  useLayoutEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      current.current = target;
      setDisplayed(target);
    };
    const onMotionChange = () => {
      if (motion.matches) finish();
    };
    motion.addEventListener("change", onMotionChange);

    if (target == null || current.current == null || target === current.current || motion.matches) {
      finish();
    } else {
      const from = current.current;
      const started = performance.now();
      const advance = (now) => {
        const progress = Math.min(1, Math.max(0, (now - started) / duration));
        const factor = 10 ** precision;
        current.current = progress === 1 ? target : Math.round((from + (target - from) * (1 - (1 - progress) ** 3)) * factor) / factor || 0;
        setDisplayed(current.current);
        if (progress < 1) frame = requestAnimationFrame(advance);
      };
      frame = requestAnimationFrame(advance);
    }

    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", onMotionChange);
    };
  }, [target, duration, precision]);

  return displayed ?? target;
}
