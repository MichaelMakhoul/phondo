import { Metadata } from "next";
import Link from "next/link";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

export const metadata: Metadata = {
  title: "Terms of Service | Phondo",
  description: "Terms of Service for Phondo AI Receptionist",
};

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <div className="container max-w-3xl py-12 px-4">
          <h1 className="mb-8 text-3xl font-bold">Terms of Service</h1>

          <div className="prose prose-gray dark:prose-invert max-w-none">
            <p className="text-muted-foreground">
              Last updated: January 2026
            </p>

            <h2>1. Acceptance of Terms</h2>
            <p>
              By accessing or using Phondo (&quot;the Service&quot;), you agree to be bound
              by these Terms of Service. If you do not agree to these terms, please
              do not use the Service.
            </p>

            <h2>2. Description of Service</h2>
            <p>
              Phondo provides AI-powered virtual receptionist services that can
              answer phone calls, schedule appointments, and handle customer inquiries
              on behalf of your business.
            </p>

            <h2>3. Account Registration</h2>
            <p>
              To use the Service, you must register for an account and provide accurate,
              complete information. You are responsible for maintaining the security
              of your account credentials.
            </p>

            <h2>4. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul>
              <li>Violate any applicable laws or regulations</li>
              <li>Infringe on the rights of others</li>
              <li>Send spam or unsolicited communications</li>
              <li>Transmit malicious code or interfere with the Service</li>
              <li>Impersonate any person or entity</li>
            </ul>

            <h2>5. Payment Terms</h2>
            <p>
              Subscription fees are billed in advance on a monthly basis. Usage-based
              charges are billed at the end of each billing period. All fees are
              non-refundable unless otherwise specified.
            </p>

            <h2>6. Intellectual Property</h2>
            <p>
              The Service and its original content, features, and functionality are
              owned by Phondo and are protected by international copyright,
              trademark, and other intellectual property laws.
            </p>

            <h2>7. Privacy</h2>
            <p>
              Your use of the Service is also governed by our{" "}
              <Link href="/privacy" className="text-orange-500 hover:underline">
                Privacy Policy
              </Link>
              . Please review it to understand how we collect, use, and protect your
              information.
            </p>

            <h2>8. Limitation of Liability</h2>
            <p>
              The Service is provided &quot;as is&quot; without warranties of any kind. We shall
              not be liable for any indirect, incidental, special, consequential, or
              punitive damages arising from your use of the Service.
            </p>

            <h2>9. Termination</h2>
            <p>
              We may terminate or suspend your account at any time for violations of
              these Terms. You may also cancel your account at any time through your
              account settings.
            </p>

            <h2>10. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. We will notify
              you of any changes by posting the new Terms on this page and updating
              the &quot;Last updated&quot; date.
            </p>

            <h2>11. Contact Us</h2>
            <p>
              If you have any questions about these Terms, please contact us at{" "}
              <a href="mailto:support@phondo.ai" className="text-orange-500 hover:underline">
                support@phondo.ai
              </a>
              .
            </p>
          </div>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
