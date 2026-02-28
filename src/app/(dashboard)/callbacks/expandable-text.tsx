"use client";

import { useState } from "react";

export function ExpandableText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <p
      className={`${className || ""} ${expanded ? "" : "line-clamp-2"} cursor-pointer`}
      onClick={() => setExpanded(!expanded)}
    >
      {text}
    </p>
  );
}
