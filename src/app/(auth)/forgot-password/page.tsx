"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import {
  CAPTCHA_PENDING_MESSAGE,
  captchaFailedUserMessage,
  isCaptchaConfigured,
  isCaptchaFailedError,
} from "@/lib/captcha";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, CheckCircle2, Phone } from "lucide-react";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaLoadFailed, setCaptchaLoadFailed] = useState(false);
  const [captchaNotice, setCaptchaNotice] = useState<{
    message: string;
    tone: "pending" | "error";
  } | null>(null);
  const captchaRef = useRef<TurnstileHandle>(null);
  const supabase = createClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // SCRUM-436: Managed-mode Turnstile usually completes silently within a
    // second of page load — only block while it is genuinely still loading.
    // If the widget terminally failed (script blocked), let the submit reach
    // Supabase: its server-side captcha_failed rejection carries real guidance,
    // and if CAPTCHA happens to be off server-side the user isn't blocked at all.
    if (isCaptchaConfigured() && !captchaToken && !captchaLoadFailed) {
      setCaptchaNotice({ message: CAPTCHA_PENDING_MESSAGE, tone: "pending" });
      return;
    }
    setCaptchaNotice(null);
    setIsLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?redirect=/settings`,
      captchaToken: captchaToken ?? undefined,
    });

    // Turnstile tokens are single-use — get a fresh one for any retry.
    captchaRef.current?.reset();

    // SCRUM-436: a captcha rejection happens BEFORE any identity lookup, so
    // surfacing it leaks nothing about account existence — and suppressing it
    // would show "check your email" when no email was sent.
    if (error && isCaptchaFailedError(error)) {
      setCaptchaNotice({
        message: captchaFailedUserMessage({ widgetLoadFailed: captchaLoadFailed }),
        tone: "error",
      });
      setIsLoading(false);
      return;
    }

    // SCRUM-412: never reveal whether an account exists for this email — show the
    // same neutral "check your email" screen regardless of the result. (Supabase
    // already avoids enumerating; surfacing the error could leak. Email-send
    // throttling is enforced by Supabase Auth via dashboard config.)
    if (error) {
      // Log generically (not error.message) so nothing existence-differentiating
      // ever lands in the requester's own console.
      console.warn("[forgot-password] reset request returned an error (suppressed for anti-enumeration)");
    }

    setIsSubmitted(true);
    setIsLoading(false);
  };

  if (isSubmitted) {
    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-hero-gradient px-4">
        <div className="absolute inset-0 bg-grid-pattern" />
        <div className="relative w-full max-w-md">
          <Link href="/" className="mb-8 flex items-center justify-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500">
              <Phone className="h-5 w-5 text-white" />
            </div>
            <span className="text-2xl font-bold text-white">Phondo</span>
          </Link>
          <Card className="w-full">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
                <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <CardTitle className="text-2xl">Check your email</CardTitle>
              <CardDescription>
                We&apos;ve sent a password reset link to <strong>{email}</strong>
              </CardDescription>
            </CardHeader>
            <CardContent className="text-center text-sm text-muted-foreground">
              <p>
                Click the link in the email to reset your password. If you don&apos;t see
                the email, check your spam folder.
              </p>
            </CardContent>
            <CardFooter className="flex justify-center">
              <Link href="/login">
                <Button variant="outline">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to login
                </Button>
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-hero-gradient px-4">
      <div className="absolute inset-0 bg-grid-pattern" />
      <div className="relative w-full max-w-md">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500">
            <Phone className="h-5 w-5 text-white" />
          </div>
          <span className="text-2xl font-bold text-white">Phondo</span>
        </Link>
        <Card className="w-full">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">Forgot password?</CardTitle>
            <CardDescription>
              Enter your email address and we&apos;ll send you a link to reset your
              password.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
              <TurnstileWidget
                ref={captchaRef}
                onToken={(token) => {
                  setCaptchaToken(token);
                  // A fresh token makes any "please wait" notice stale.
                  if (token) setCaptchaNotice(null);
                }}
                onError={() => setCaptchaLoadFailed(true)}
                className="flex justify-center"
              />
              {captchaNotice && (
                <p
                  role="alert"
                  className={cn(
                    "text-center text-sm",
                    captchaNotice.tone === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {captchaNotice.message}
                </p>
              )}
              <Button type="submit" className="w-full bg-orange-500 text-white hover:bg-orange-600" disabled={isLoading}>
                {isLoading ? "Sending..." : "Send reset link"}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="flex justify-center text-sm text-muted-foreground">
            <Link href="/login" className="flex items-center hover:text-foreground">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to login
            </Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
