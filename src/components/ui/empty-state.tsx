import { type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  /** Custom illustration to replace the default icon-in-rings */
  illustration?: ReactNode;
  /** Compact variant for smaller containers like sidebars */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  illustration,
  compact = false,
  className,
}: EmptyStateProps) {
  if (compact) {
    return (
      <div className={cn("flex flex-col items-center justify-center py-8 text-center", className)}>
        {illustration ? (
          <div className="mb-3">{illustration}</div>
        ) : (
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-[200px]">
          {description}
        </p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center animate-fade-in-up", className)}>
      {illustration ? (
        <div className="mb-6">{illustration}</div>
      ) : (
        <div className="relative mb-6 h-14 w-14">
          {/* Decorative rings */}
          <div className="absolute inset-0 -m-3 rounded-full bg-primary/5" />
          <div className="absolute inset-0 -m-1.5 rounded-full bg-primary/10" />
          <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary/15">
            <Icon className="h-7 w-7 text-primary" />
          </div>
        </div>
      )}
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
