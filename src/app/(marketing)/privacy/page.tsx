import { Metadata } from "next";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { MarketingFooter } from "@/components/marketing/marketing-footer";

export const metadata: Metadata = {
  title: "Privacy Policy | Phondo",
  description: "Privacy Policy for Phondo AI Receptionist",
};

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingHeader />

      <main className="flex-1">
        <div className="container max-w-3xl py-12 px-4">
          <h1 className="mb-8 text-3xl font-bold">Privacy Policy</h1>

          <div className="prose prose-gray dark:prose-invert max-w-none">
            <p className="text-muted-foreground">
              Last updated: July 2026
            </p>

            <h2>1. Introduction</h2>
            <p>
              Phondo (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) is committed to protecting your
              privacy. This Privacy Policy explains how we collect, use, disclose,
              and safeguard your information when you use our AI receptionist service.
            </p>

            <h2>2. Information We Collect</h2>
            <h3>Account Information</h3>
            <p>
              When you create an account, we collect your name, email address, business
              name, and payment information.
            </p>

            <h3>Call Data</h3>
            <p>
              When calls are processed through our service, we may collect:
            </p>
            <ul>
              <li>Phone numbers (caller and recipient)</li>
              <li>Call recordings (if enabled)</li>
              <li>Call transcripts</li>
              <li>Call duration and timestamps</li>
            </ul>

            <h3>Usage Data</h3>
            <p>
              We automatically collect information about how you interact with the
              Service, including pages visited, features used, and error logs.
            </p>

            <h2>3. How We Use Your Information</h2>
            <p>We use the collected information to:</p>
            <ul>
              <li>Provide and maintain the Service</li>
              <li>Process transactions and send billing notifications</li>
              <li>Improve and personalize the Service</li>
              <li>Send you updates and marketing communications</li>
              <li>Respond to your comments and questions</li>
              <li>Monitor and analyze usage patterns</li>
            </ul>

            <h2>4. Data Sharing</h2>
            <p>We may share your information with:</p>
            <ul>
              <li>
                <strong>Service Providers:</strong> Third-party vendors who help us
                operate the Service (e.g., cloud hosting, payment processing, voice AI)
              </li>
              <li>
                <strong>Legal Requirements:</strong> When required by law or to protect
                our rights
              </li>
              <li>
                <strong>Business Transfers:</strong> In connection with a merger,
                acquisition, or sale of assets
              </li>
            </ul>

            <h2>5. Where Your Data Is Stored and Processed</h2>
            <p>
              Your account data, call transcripts, and business information are
              stored at rest in Australia, in our Sydney region.
            </p>
            <p>
              However, some of your information is processed by trusted
              third-party providers that may store or process data outside
              Australia, including in the United States. In particular:
            </p>
            <ul>
              <li>
                <strong>Voice AI:</strong> the real-time speech and language
                models that power each conversation
              </li>
              <li>
                <strong>Telephony:</strong> call transport and any call
                recordings (handled by our telephony provider)
              </li>
              <li>
                <strong>Payments and monitoring:</strong> payment processing and
                error/performance monitoring
              </li>
            </ul>
            <p>
              We put contractual protections in place with these providers,
              including terms that prohibit them from using your data to train
              their models. By using the Service, you consent to this overseas
              processing. This disclosure is made consistent with Australian
              Privacy Principle 8. We do not claim that your data never leaves
              Australia; we aim to be transparent about exactly where it is
              handled. Contact us at{" "}
              <a href="mailto:privacy@phondo.ai" className="text-orange-500 hover:underline">
                privacy@phondo.ai
              </a>{" "}
              for our current list of sub-processors.
            </p>

            <h2>6. Data Security</h2>
            <p>
              We implement industry-standard security measures to protect your data,
              including encryption in transit (TLS) and at rest (AES-256), and
              row-level isolation of each organisation&apos;s data. However, no
              method of transmission over the Internet is 100% secure.
            </p>

            <h2>7. Data Retention</h2>
            <p>
              We retain your data for as long as your account is active or as needed
              to provide the Service. Call recordings are retained according to your
              settings, with a maximum retention period of 90 days unless otherwise
              configured.
            </p>

            <h2>8. Your Rights</h2>
            <p>You have the right to:</p>
            <ul>
              <li>Access your personal data</li>
              <li>Correct inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Object to processing of your data</li>
              <li>Export your data in a portable format</li>
            </ul>

            <h2>9. Cookies</h2>
            <p>
              We use cookies and similar tracking technologies to track activity on
              our Service and hold certain information. You can instruct your browser
              to refuse all cookies or indicate when a cookie is being sent.
            </p>

            <h2>10. Children&apos;s Privacy</h2>
            <p>
              The Service is not intended for use by anyone under the age of 18. We
              do not knowingly collect personal information from children under 18.
            </p>

            <h2>11. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify you
              of any changes by posting the new Privacy Policy on this page and
              updating the &quot;Last updated&quot; date.
            </p>

            <h2>12. Contact Us</h2>
            <p>
              If you have questions about this Privacy Policy, please contact us at{" "}
              <a href="mailto:privacy@phondo.ai" className="text-orange-500 hover:underline">
                privacy@phondo.ai
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
