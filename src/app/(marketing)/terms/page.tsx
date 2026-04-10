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
              Last updated: April 2026
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
              on behalf of your business. The Service includes provisioning of phone
              numbers, AI-driven call handling, SMS notifications, appointment booking,
              and related telephony features.
            </p>

            <h2>3. Account Registration</h2>
            <p>
              To use the Service, you must register for an account and provide accurate,
              complete information. You are responsible for maintaining the security
              of your account credentials.
            </p>

            <h2>4. Telephony Services and Phone Numbers</h2>
            <p>
              The Service provisions phone numbers on your behalf through third-party
              telephony providers. By using the Service, you acknowledge and agree that:
            </p>
            <ol>
              <li>
                <strong>Phone numbers are provisioned under Phondo&apos;s carrier accounts.</strong>{" "}
                Phondo holds the direct relationship with telephony carriers. Phone numbers
                assigned to your account remain the property of Phondo and its carriers. You
                are granted a non-exclusive, revocable licence to use the assigned number(s)
                for the duration of your active subscription.
              </li>
              <li>
                <strong>Number portability.</strong> If you cancel your subscription, you may
                request to port your number to another provider, subject to carrier policies
                and applicable fees. We will make reasonable efforts to facilitate porting
                within 30 days of request.
              </li>
              <li>
                <strong>Service availability.</strong> Telephony services depend on third-party
                carriers and infrastructure. We do not guarantee uninterrupted service and are
                not liable for carrier outages, network failures, or call quality issues outside
                our control.
              </li>
              <li>
                <strong>Emergency calls.</strong> The Service is not a replacement for
                traditional phone lines and cannot be used to contact emergency services
                (e.g., 000, 911, 112). You must maintain separate access to emergency calling
                services.
              </li>
            </ol>

            <h2>5. Acceptable Use Policy</h2>
            <p>
              You are solely responsible for all activity conducted through your account
              and the phone numbers assigned to it. You agree not to use the Service to:
            </p>
            <ul>
              <li>Violate any applicable laws or regulations, including telecommunications
                laws, consumer protection laws, and privacy regulations</li>
              <li>Make or facilitate harassing, threatening, abusive, or fraudulent communications</li>
              <li>Send spam, unsolicited commercial messages, or bulk automated communications
                in violation of applicable anti-spam laws (including the Spam Act 2003 (AU),
                TCPA (US), and CAN-SPAM Act)</li>
              <li>Engage in telephony fraud, including but not limited to robocalling schemes,
                vishing (voice phishing), caller ID spoofing for deceptive purposes, or
                toll fraud</li>
              <li>Impersonate any person, business, or entity, or misrepresent your affiliation
                with any person or entity</li>
              <li>Use the AI receptionist to provide professional advice (legal, medical,
                financial) that the AI is not qualified to give</li>
              <li>Configure the AI to make false claims, guarantees, or representations to callers</li>
              <li>Attempt to circumvent usage limits, billing controls, or security measures</li>
              <li>Use the Service for any activity that could harm the reputation or deliverability
                of the phone numbers, including activities that result in carrier complaints,
                number blocks, or regulatory action</li>
              <li>Transmit malicious code or interfere with the operation of the Service</li>
            </ul>
            <p>
              Phondo reserves the right to immediately suspend or terminate accounts that
              violate this Acceptable Use Policy, without prior notice or refund. We may
              also report illegal activity to the relevant law enforcement authorities.
            </p>

            <h2>6. Your Responsibilities</h2>
            <p>
              As the account holder, you are responsible for:
            </p>
            <ul>
              <li>Ensuring the AI receptionist is configured with accurate business information</li>
              <li>Complying with all applicable laws in your jurisdiction, including consumer
                protection, telecommunications, privacy, and industry-specific regulations
                (e.g., HIPAA, AHPRA, TCPA)</li>
              <li>Obtaining any required consents from your callers for call recording,
                data collection, or SMS communications</li>
              <li>Monitoring call transcripts and AI behaviour to ensure accuracy and
                appropriateness</li>
              <li>Promptly addressing any issues reported by callers regarding the AI&apos;s behaviour</li>
              <li>Maintaining compliance with Do Not Call (DNC) regulations and honouring
                opt-out requests from callers</li>
            </ul>

            <h2>7. SMS and Messaging Compliance</h2>
            <p>
              If you enable SMS features (text-back on missed calls, appointment
              confirmations, or other automated messaging), you agree that:
            </p>
            <ol>
              <li>
                <strong>Consent is required.</strong> You must have proper consent to send
                automated text messages to individuals, as required by applicable law
                (including TCPA, Spam Act 2003, and other anti-spam regulations).
              </li>
              <li>
                <strong>Opt-out compliance.</strong> All automated messages include opt-out
                instructions. You must honour opt-out requests immediately. Phondo
                automatically processes STOP/UNSUBSCRIBE keywords, but you are ultimately
                responsible for compliance.
              </li>
              <li>
                <strong>Message content.</strong> You are responsible for the content of
                messages sent through the Service on your behalf. Phondo is not liable for
                messages that violate applicable laws or regulations.
              </li>
            </ol>

            <h2>8. Payment Terms</h2>
            <p>
              Subscription fees are billed in advance on a monthly basis. Usage-based
              charges (including call minutes and SMS) are billed at the end of each
              billing period. All fees are non-refundable unless otherwise specified.
              Phone number fees are charged monthly and begin from the date of provisioning.
            </p>

            <h2>9. Intellectual Property</h2>
            <p>
              The Service and its original content, features, and functionality are
              owned by Phondo and are protected by international copyright,
              trademark, and other intellectual property laws.
            </p>

            <h2>10. Privacy</h2>
            <p>
              Your use of the Service is also governed by our{" "}
              <Link href="/privacy" className="text-orange-500 hover:underline">
                Privacy Policy
              </Link>
              . Please review it to understand how we collect, use, and protect your
              information.
            </p>

            <h2>11. Call Recording</h2>
            <p>
              Phondo provides call recording functionality as an optional feature.
              By enabling call recording, you acknowledge and agree that:
            </p>
            <ol>
              <li>
                <strong>You are solely responsible</strong> for complying with all
                applicable laws and regulations regarding call recording in your
                jurisdiction, including but not limited to obtaining any required
                consent from callers.
              </li>
              <li>
                <strong>Phondo provides a recording disclosure</strong> message at
                the beginning of each call (&quot;This call may be recorded for
                quality and training purposes&quot;). However, it is your
                responsibility to ensure this disclosure meets the legal
                requirements in your jurisdiction.
              </li>
              <li>
                <strong>One-party vs two-party consent</strong>: Recording laws
                vary by jurisdiction. Some require all parties to consent to
                recording (two-party/all-party consent), while others only require
                one party&apos;s consent. You must determine and comply with the
                applicable consent requirements.
              </li>
              <li>
                <strong>Data retention</strong>: Call recordings are stored securely
                by our telephony providers. You are responsible for managing
                recording retention in accordance with your industry regulations and
                privacy obligations.
              </li>
              <li>
                <strong>Phondo disclaims all liability</strong> for any legal
                consequences arising from your use of the call recording feature,
                including but not limited to violations of wiretapping laws, privacy
                regulations, or industry-specific compliance requirements (e.g.,
                HIPAA, AHPRA).
              </li>
              <li>
                <strong>To disable recording</strong>: You can disable call
                recording at any time through your organization settings by setting
                the recording mode to &quot;Never&quot;.
              </li>
            </ol>

            <h2>12. AI Limitations and Disclaimer</h2>
            <p>
              You acknowledge that the AI receptionist:
            </p>
            <ul>
              <li>May occasionally misunderstand callers, provide inaccurate information,
                or fail to handle calls as expected</li>
              <li>Is not a substitute for human staff in situations requiring professional
                judgement, empathy, or complex decision-making</li>
              <li>Should not be relied upon as the sole means of communication for
                critical, time-sensitive, or emergency situations</li>
              <li>Operates based on the information and instructions you provide — inaccurate
                configuration may lead to inaccurate responses to callers</li>
            </ul>
            <p>
              Phondo is not liable for any business losses, missed opportunities, or
              damages arising from the AI&apos;s handling of calls, including incorrect
              information provided to callers, missed calls, or failed appointment bookings.
            </p>

            <h2>13. Limitation of Liability</h2>
            <p>
              The Service is provided &quot;as is&quot; without warranties of any kind,
              whether express or implied. To the maximum extent permitted by law, we shall
              not be liable for any indirect, incidental, special, consequential, or
              punitive damages arising from your use of the Service, including but not
              limited to loss of revenue, lost business opportunities, data loss, or
              reputational harm.
            </p>
            <p>
              Our total aggregate liability for any claims arising from or related to
              the Service shall not exceed the amount you paid to Phondo in the twelve
              (12) months preceding the claim.
            </p>

            <h2>14. Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless Phondo, its officers,
              directors, employees, and agents from and against any claims, damages,
              losses, liabilities, costs, and expenses (including reasonable legal fees)
              arising from:
            </p>
            <ul>
              <li>Your use of the Service or any activity conducted through your account</li>
              <li>Your violation of these Terms or any applicable law</li>
              <li>Your violation of any third-party rights, including privacy or
                telecommunications regulations</li>
              <li>Any claims by callers, customers, or third parties related to calls
                handled by the AI receptionist on your behalf</li>
              <li>Any regulatory action, fines, or penalties resulting from your use of
                the telephony features</li>
            </ul>

            <h2>15. Termination</h2>
            <p>
              We may terminate or suspend your account immediately, without prior notice,
              for violations of these Terms, including but not limited to violations of
              the Acceptable Use Policy, non-payment, or fraudulent activity. You may also
              cancel your account at any time through your account settings. Upon
              termination, your phone numbers will be released after a 30-day grace
              period unless you request porting.
            </p>

            <h2>16. Changes to Terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. We will notify
              you of material changes by email and by posting the new Terms on this page,
              updating the &quot;Last updated&quot; date. Continued use of the Service
              after changes take effect constitutes acceptance of the revised Terms.
            </p>

            <h2>17. Governing Law</h2>
            <p>
              These Terms are governed by and construed in accordance with the laws of
              New South Wales, Australia, without regard to conflict of law principles.
              Any disputes arising from these Terms shall be subject to the exclusive
              jurisdiction of the courts of New South Wales.
            </p>

            <h2>18. Contact Us</h2>
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
