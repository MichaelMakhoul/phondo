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

export function CallsScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Phone className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute -top-1 -right-1 animate-orbit">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-green-500/10">
          <PhoneIncoming className="h-3.5 w-3.5 text-green-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function AssistantsScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Bot className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute -top-1 -right-1 animate-orbit">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-yellow-500/10">
          <Sparkles className="h-3.5 w-3.5 text-yellow-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function PhoneScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Phone className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute top-0 right-0 animate-float">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="h-3 w-3 text-primary" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function CallbacksScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <PhoneForwarded className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute -top-1 -right-1 animate-orbit">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-500/10">
          <Clock className="h-3.5 w-3.5 text-blue-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function CalendarScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <CalendarDays className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute top-0 right-0 animate-float">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500/10">
          <CalendarCheck2 className="h-3 w-3 text-green-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function KnowledgeScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <BookOpen className="h-7 w-7 text-primary" />
      </div>
      {/* Typing dots */}
      <div className="absolute bottom-1 flex items-center gap-1">
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot" />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot-delay-1" />
        <div className="h-1.5 w-1.5 rounded-full bg-primary/60 animate-typing-dot-delay-2" />
      </div>
      <div className="absolute top-0 -right-1 animate-float">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/10">
          <FileText className="h-3 w-3 text-blue-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function TeamScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Users className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute -top-1 -right-1 animate-orbit">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-green-500/10">
          <UserPlus className="h-3.5 w-3.5 text-green-500" />
        </div>
      </div>
    </SceneContainer>
  );
}

export function IntegrationsScene() {
  return (
    <SceneContainer>
      <PulsingRing />
      <PulsingRing delay size="md" />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 animate-scale-in">
        <Webhook className="h-7 w-7 text-primary" />
      </div>
      <div className="absolute top-0 right-0 animate-float">
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-yellow-500/10">
          <Zap className="h-3 w-3 text-yellow-500" />
        </div>
      </div>
    </SceneContainer>
  );
}
