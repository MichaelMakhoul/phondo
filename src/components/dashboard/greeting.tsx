"use client";

import { useEffect, useState } from "react";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function DashboardGreeting({ firstName }: { firstName: string | null }) {
  const [greeting, setGreeting] = useState("Welcome");

  useEffect(() => {
    setGreeting(getGreeting());
  }, []);

  return (
    <h1 className="text-2xl font-bold">
      {greeting}{firstName ? `, ${firstName}` : ""}
    </h1>
  );
}
