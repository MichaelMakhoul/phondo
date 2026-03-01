import { type LucideIcon } from "lucide-react";
import {
  Phone,
  PhoneIncoming,
  Bot,
  Sparkles,
  PhoneForwarded,
  Clock,
  CalendarDays,
  CalendarCheck2,
  BookOpen,
  FileText,
  Users,
  UserPlus,
  Webhook,
  Zap,
} from "lucide-react";

function SceneContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-24 w-24 flex items-center justify-center">
      {children}
    </div>
  );
}

function PulsingRing({ delay = false, size = "lg" }: { delay?: boolean; size?: "md" | "lg" }) {
  const sizeClass = size === "lg" ? "h-20 w-20" : "h-16 w-16";
  return (
    <div
      className={`absolute rounded-full border border-primary/20 ${sizeClass} ${
        delay ? "animate-ring-pulse-delay" : "animate-ring-pulse"
      }`}
    />
  );
}

interface AccentConfig {
  icon: LucideIcon;
  bgColor: string;
  iconColor: string;
  animation: "orbit" | "float";
  position?: string;
}

interface AnimatedSceneProps {
  icon: LucideIcon;
  accent: AccentConfig;
  singleRing?: boolean;
  extra?: React.ReactNode;
}

function AnimatedScene({ icon: Icon, accent, singleRing, extra }: AnimatedSceneProps) {
  const AccentIcon = accent.icon;
  const isOrbit = accent.animation === "orbit";
  const position = accent.position ?? (isOrbit ? "-top-1 -right-1" : "top-0 right-0");
  const containerSize = isOrbit ? "h-7 w-7" : "h-6 w-6";
  const iconSize = isOrbit ? "h-3.5 w-3.5" : "h-3 w-3";
  const animClass = isOrbit ? "animate-orbit" : "animate-float";

  return (
    <SceneContainer>
      <PulsingRing />
      {!singleRing && <PulsingRing delay size="md" />}
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Icon className="h-7 w-7 text-primary" />
      </div>
      {extra}
      <div className={`absolute ${position} ${animClass}`}>
        <div className={`flex ${containerSize} items-center justify-center rounded-full ${accent.bgColor}`}>
          <AccentIcon className={`${iconSize} ${accent.iconColor}`} />
        </div>
      </div>
    </SceneContainer>
  );
}

export function CallsScene() {
  return (
    <AnimatedScene
      icon={Phone}
      accent={{ icon: PhoneIncoming, bgColor: "bg-green-500/10", iconColor: "text-green-500", animation: "orbit" }}
    />
  );
}

export function AssistantsScene() {
  return (
    <AnimatedScene
      icon={Bot}
      accent={{ icon: Sparkles, bgColor: "bg-yellow-500/10", iconColor: "text-yellow-500", animation: "orbit" }}
    />
  );
}

export function PhoneScene() {
  return (
    <AnimatedScene
      icon={Phone}
      accent={{ icon: Sparkles, bgColor: "bg-primary/10", iconColor: "text-primary", animation: "float" }}
    />
  );
}

export function CallbacksScene() {
  return (
    <AnimatedScene
      icon={PhoneForwarded}
      accent={{ icon: Clock, bgColor: "bg-blue-500/10", iconColor: "text-blue-500", animation: "orbit" }}
    />
  );
}

export function CalendarScene() {
  return (
    <AnimatedScene
      icon={CalendarDays}
      accent={{ icon: CalendarCheck2, bgColor: "bg-green-500/10", iconColor: "text-green-500", animation: "float" }}
    />
  );
}

export function KnowledgeScene() {
  return (
    <AnimatedScene
      icon={BookOpen}
      accent={{ icon: FileText, bgColor: "bg-blue-500/10", iconColor: "text-blue-500", animation: "float", position: "top-0 -right-1" }}
      singleRing
      extra={
        <div className="absolute bottom-1 flex items-center gap-1">
          <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot" />
          <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot-delay-1" />
          <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot-delay-2" />
        </div>
      }
    />
  );
}

export function TeamScene() {
  return (
    <AnimatedScene
      icon={Users}
      accent={{ icon: UserPlus, bgColor: "bg-green-500/10", iconColor: "text-green-500", animation: "orbit" }}
    />
  );
}

export function IntegrationsScene() {
  return (
    <AnimatedScene
      icon={Webhook}
      accent={{ icon: Zap, bgColor: "bg-yellow-500/10", iconColor: "text-yellow-500", animation: "float" }}
    />
  );
}
