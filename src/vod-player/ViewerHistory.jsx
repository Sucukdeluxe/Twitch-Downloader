import React, { useMemo } from "react";
import { ViewerEye } from "./ViewerEye.jsx";
import { createStreamClock } from "./stream-clock.js";
import { useAnimatedCount } from "./useAnimatedCount.js";
import "./viewer-history.css";

export function ViewerCount({ sample, t, overlay = false }) {
  const locale = t("locale");
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const clock = useMemo(() => createStreamClock(locale), [locale]);
  const viewers = useAnimatedCount(sample?.viewers ?? null);
  if (!sample) return null;
  const label = `${format.format(sample.viewers)} ${t("viewerCount")}`;
  const measured = `${t("viewerMeasuredAt")}: ${clock(sample.at, 0)?.label || ""}`;
  return <span className={`viewer-count${overlay ? " viewer-count-overlay" : ""}`} title={measured} aria-label={`${label} · ${measured}`}><ViewerEye/><span aria-hidden="true">{format.format(viewers)} {t("viewerCount")}</span></span>;
}

export function ViewerHistory({ curves }) {
  if (!curves.length) return null;
  return <span className="viewer-history" aria-hidden="true"><svg className="viewer-history-plot" viewBox="0 0 1000 32" preserveAspectRatio="none">
    <path d={curves.filter(curve => !curve.point).map(curve => curve.area).join(" ")} className="viewer-history-area"/>
    {curves.map((curve,index) => <g key={index}>{curve.point
      ? <line x1={curve.point[0]} x2={curve.point[0]} y1={curve.point[1]} y2={curve.point[1] + .01} strokeLinecap="round" className="viewer-history-line viewer-history-point"/>
      : <path d={curve.line} className={`viewer-history-line${curve.gap ? " viewer-history-gap" : ""}`}/>}</g>)}
  </svg></span>;
}
