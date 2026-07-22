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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import { Phone } from "lucide-react";
import { trackSignUp, trackEarlyAccessRequest } from "@/lib/analytics";

const SIGNUP_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SIGNUP === "true";

export default function SignupPage() {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaLoadFailed, setCaptchaLoadFailed] = useState(false);
  const captchaRef = useRef<TurnstileHandle>(null);
  const { toast } = useToast();
  const supabase = createClient();

  // Early-access form (shown only while SIGNUP_ENABLED is false). Kept separate
  // from the main signup form above — only one of the two branches ever renders.
  const [eaName, setEaName] = useState("");
  const [eaBusiness, setEaBusiness] = useState("");
  const [eaEmail, setEaEmail] = useState("");
  const [eaPhone, setEaPhone] = useState("");
  const [eaMessage, setEaMessage] = useState("");
  const [eaWebsite, setEaWebsite] = useState(""); // honeypot — humans leave this empty
  const [eaSubmitting, setEaSubmitting] = useState(false);
  const [eaSubmitted, setEaSubmitted] = useState(false);

  const handleEarlyAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setEaSubmitting(true);
    try {
      const res = await fetch("/api/v1/early-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: eaName,
          businessName: eaBusiness,
          email: eaEmail,
          phone: eaPhone,
          message: eaMessage,
          website: eaWebsite,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        tracked?: boolean;
        error?: string;
      };
      if (res.ok && json.ok) {
        // Commit the success UX FIRST — analytics must never break it.
        setEaSubmitted(true);
        // SCRUM-569: count the lead (GA + PostHog) and fire the Google Ads
        // conversion so paid-campaign cost-per-lead is measurable — but ONLY for
        // a genuinely persisted lead (`tracked`). The honeypot path returns
        // { ok: true } without it, so a trap trip never records a phantom
        // conversion. Count-only; no PII leaves the client (details went to the
        // server above), and the facade swallows internally — the try is belt-
        // and-suspenders so a redefined dataLayer can't undo the success state.
        if (json.tracked) {
          try {
            trackEarlyAccessRequest();
          } catch {
            /* telemetry must never break the success flow */
          }
        }
        return;
      }
      toast({
        variant: "destructive",
        title: "Couldn't send that",
        description: json.error || "Something went wrong. Please try again, or email hello@phondo.ai.",
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Network error",
        description: "Please check your connection and try again, or email hello@phondo.ai.",
      });
    } finally {
      setEaSubmitting(false);
    }
  };

  if (!SIGNUP_ENABLED) {
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
              <CardTitle className="text-2xl">Phondo is in private beta</CardTitle>
              <CardDescription>
                We&apos;re onboarding customers one at a time while we finish polishing the platform. Drop us a line and we&apos;ll add you to the early-access list.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {eaSubmitted ? (
                <div className="space-y-2 rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-center">
                  <p className="font-medium text-foreground">Thanks — you&apos;re on the list.</p>
                  <p className="text-sm text-muted-foreground">
                    The Phondo team will be in touch shortly. Want it sooner? Call us on{" "}
                    <a href="tel:+61257015064" className="text-orange-500 hover:underline">
                      02&nbsp;5701&nbsp;5064
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <form onSubmit={handleEarlyAccess} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="ea-name">Full name</Label>
                    <Input
                      id="ea-name"
                      value={eaName}
                      onChange={(e) => setEaName(e.target.value)}
                      placeholder="Jane Smith"
                      required
                      disabled={eaSubmitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ea-business">
                      Business name <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="ea-business"
                      value={eaBusiness}
                      onChange={(e) => setEaBusiness(e.target.value)}
                      placeholder="Smith Dental"
                      disabled={eaSubmitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ea-email">Email</Label>
                    <Input
                      id="ea-email"
                      type="email"
                      value={eaEmail}
                      onChange={(e) => setEaEmail(e.target.value)}
                      placeholder="you@example.com"
                      required
                      disabled={eaSubmitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ea-phone">
                      Phone <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Input
                      id="ea-phone"
                      type="tel"
                      value={eaPhone}
                      onChange={(e) => setEaPhone(e.target.value)}
                      placeholder="Best number to reach you"
                      disabled={eaSubmitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ea-message">
                      Anything we should know? <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea
                      id="ea-message"
                      value={eaMessage}
                      onChange={(e) => setEaMessage(e.target.value)}
                      placeholder="e.g. we miss a lot of calls at reception"
                      rows={3}
                      disabled={eaSubmitting}
                    />
                  </div>
                  {/* Honeypot: positioned off-screen, hidden from users; bots that
                      fill every field trip it and get silently dropped server-side. */}
                  <input
                    type="text"
                    name="website"
                    tabIndex={-1}
                    autoComplete="off"
                    aria-hidden="true"
                    className="hidden"
                    value={eaWebsite}
                    onChange={(e) => setEaWebsite(e.target.value)}
                  />
                  <Button
                    type="submit"
                    className="w-full bg-orange-500 text-white hover:bg-orange-600"
                    disabled={eaSubmitting}
                  >
                    {eaSubmitting ? "Sending..." : "Request early access"}
                  </Button>
                </form>
              )}
            </CardContent>
            <CardFooter className="justify-center text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="ml-1 text-orange-500 hover:underline">
                Sign in
              </Link>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  const handleEmailSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    // SCRUM-436: Managed-mode Turnstile usually completes silently within a
    // second of page load — only block while it is genuinely still loading.
    // If the widget terminally failed (script blocked), let the submit reach
    // Supabase: its server-side captcha_failed rejection carries real guidance,
    // and if CAPTCHA happens to be off server-side the user isn't blocked at all.
    if (isCaptchaConfigured() && !captchaToken && !captchaLoadFailed) {
      toast({ title: "Almost there", description: CAPTCHA_PENDING_MESSAGE });
      return;
    }
    setIsLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
        },
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        captchaToken: captchaToken ?? undefined,
      },
    });

    // Turnstile tokens are single-use — get a fresh one for any retry.
    captchaRef.current?.reset();

    if (error) {
      // SCRUM-412: never reveal whether an email already has an account. Treat
      // "already registered" exactly like a fresh signup (same neutral message);
      // surface only input-level errors (e.g. weak password), which do not leak
      // account existence.
      const alreadyRegistered =
        (error as { code?: string }).code === "user_already_exists" ||
        /already registered/i.test(error.message);
      if (alreadyRegistered) {
        toast({
          title: "Check your email",
          description: "We sent you a confirmation link to complete your signup.",
        });
        setIsLoading(false);
        return;
      }
      toast({
        variant: "destructive",
        title: "Signup failed",
        description: isCaptchaFailedError(error)
          ? captchaFailedUserMessage({ widgetLoadFailed: captchaLoadFailed })
          : error.message,
      });
      setIsLoading(false);
      return;
    }

    trackSignUp("email");
    toast({
      title: "Check your email",
      description: "We sent you a confirmation link to complete your signup.",
    });
    setIsLoading(false);
  };

  const handleGoogleSignup = async () => {
    setIsLoading(true);
    trackSignUp("google"); // Tracks intent — OAuth redirect means we can't track completion here
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      toast({
        variant: "destructive",
        title: "Signup failed",
        description: error.message,
      });
      setIsLoading(false);
    }
  };

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
            <CardTitle className="text-2xl">Create an account</CardTitle>
            <CardDescription>Get started with your AI receptionist</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              variant="outline"
              className="w-full"
              onClick={handleGoogleSignup}
              disabled={isLoading}
            >
              <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Continue with Google
            </Button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">Or continue with</span>
              </div>
            </div>

            <form onSubmit={handleEmailSignup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="fullName">Full name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
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
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Create a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Must be at least 8 characters
                </p>
              </div>
              <TurnstileWidget
                ref={captchaRef}
                onToken={setCaptchaToken}
                onError={() => setCaptchaLoadFailed(true)}
                className="flex justify-center"
              />
              <Button type="submit" className="w-full bg-orange-500 text-white hover:bg-orange-600" disabled={isLoading}>
                {isLoading ? "Creating account..." : "Create account"}
              </Button>
            </form>

            <p className="text-center text-xs text-muted-foreground">
              By signing up, you agree to our{" "}
              <Link href="/terms" className="underline hover:text-foreground">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="underline hover:text-foreground">
                Privacy Policy
              </Link>
            </p>
          </CardContent>
          <CardFooter className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="text-orange-500 hover:underline">
              Sign in
            </Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
