export interface IndustryFeature {
  icon: string;
  title: string;
  description: string;
}

export interface IndustryStat {
  value: string;
  label: string;
}

export interface IndustryFAQ {
  question: string;
  answer: string;
}

export interface IndustryPage {
  slug: string;
  name: string;
  heroTitle: string;
  heroSubtitle: string;
  features: IndustryFeature[];
  stats: IndustryStat[];
  faqs: IndustryFAQ[];
  ctaTitle: string;
  ctaDescription: string;
  icon: string;
  color: string;
}

export const INDUSTRY_PAGES: IndustryPage[] = [
  {
    slug: "dental",
    name: "Dental & Medical",
    icon: "Stethoscope",
    color: "rose",
    heroTitle: "An AI receptionist built for dental and medical practices",
    heroSubtitle:
      "Answer every patient call, book appointments instantly, and handle after-hours triage — without adding staff. Built for Australian healthcare with AHPRA-aware privacy standards.",
    features: [
      {
        icon: "Calendar",
        title: "Instant Appointment Booking",
        description:
          "Books check-ups, cleanings, and consultations directly into your calendar. Sends SMS confirmation to patients automatically.",
      },
      {
        icon: "Clock",
        title: "After-Hours Triage",
        description:
          "Handles late-night calls with urgency detection. Routes emergencies to your on-call dentist and takes messages for everything else.",
      },
      {
        icon: "Shield",
        title: "Patient Privacy First",
        description:
          "Australian-hosted data with AHPRA-aware handling. Never shares patient details between callers. Recording consent handled automatically.",
      },
      {
        icon: "PhoneForwarded",
        title: "Emergency Call Routing",
        description:
          "Detects urgent cases — pain, swelling, trauma — and transfers directly to the right practitioner's mobile.",
      },
      {
        icon: "MessageSquare",
        title: "Missed Call Recovery",
        description:
          "Sends patients an SMS with a booking link when they can't get through. 47% of missed callers book via text-back.",
      },
      {
        icon: "BarChart3",
        title: "Call Analytics & Insights",
        description:
          "See what patients are calling about, peak call times, and no-show patterns. Full transcripts for every call.",
      },
    ],
    stats: [
      { value: "35%", label: "reduction in no-shows with SMS confirmations" },
      { value: "62%", label: "of practice calls go unanswered during busy periods" },
      { value: "24/7", label: "patient call coverage including weekends and holidays" },
      { value: "<5min", label: "setup time with dental-specific AI training" },
    ],
    faqs: [
      {
        question: "Can it handle different appointment types (check-up, emergency, cleaning)?",
        answer:
          "Yes. The AI is pre-trained on dental terminology and distinguishes between routine bookings, emergencies, and specialist referrals. It asks the right questions for each type and books into the correct appointment slot.",
      },
      {
        question: "How does it handle patient privacy and AHPRA requirements?",
        answer:
          "All data is hosted on Australian servers in Sydney. The AI never shares information between callers and handles call recording consent automatically per state requirements. We are building towards full AHPRA compliance.",
      },
      {
        question: "What happens when a patient calls with a dental emergency after hours?",
        answer:
          "The AI detects urgency keywords (severe pain, swelling, broken tooth, bleeding) and can either transfer directly to your on-call dentist's mobile or take a detailed message with callback priority flagging.",
      },
      {
        question: "Can it handle insurance and billing questions?",
        answer:
          "The AI can answer common questions about accepted health funds, gap estimates, and payment options based on information you provide during setup. Complex billing queries are flagged for your team to follow up.",
      },
      {
        question: "Does it integrate with my practice management software?",
        answer:
          "We currently integrate with Cal.com for appointment booking. Direct integrations with Cliniko and other practice management systems are on our roadmap. Contact us if you use a specific system.",
      },
    ],
    ctaTitle: "Stop losing patients to voicemail",
    ctaDescription:
      "Every missed call is a patient who books with another practice. Start your 14-day free trial and answer every call from day one.",
  },
  {
    slug: "legal",
    name: "Legal",
    icon: "Scale",
    color: "blue",
    heroTitle: "An AI receptionist that understands legal practice",
    heroSubtitle:
      "Capture every lead, handle client intake, and schedule consultations — 24/7. Professional tone, strict confidentiality, and Australian legal compliance built in.",
    features: [
      {
        icon: "FileText",
        title: "Client Intake Capture",
        description:
          "Collects case type, urgency, key details, and contact information from every caller. Structured data lands in your dashboard ready for review.",
      },
      {
        icon: "Calendar",
        title: "Consultation Scheduling",
        description:
          "Books initial consultations directly into your calendar. Sends confirmation with your office address and what to bring.",
      },
      {
        icon: "Lock",
        title: "Strict Confidentiality",
        description:
          "Never reveals client information between calls. Australian-hosted data protects solicitor-client privilege. No offshore data transfers.",
      },
      {
        icon: "Phone",
        title: "24/7 Lead Capture",
        description:
          "Legal enquiries don't stop at 5pm. Capture potential clients calling after hours, weekends, and holidays — before they call your competitor.",
      },
      {
        icon: "PhoneForwarded",
        title: "Urgent Matter Transfers",
        description:
          "Detects time-sensitive matters — court deadlines, bail, family emergencies — and transfers directly to the relevant solicitor.",
      },
      {
        icon: "BarChart3",
        title: "Enquiry Analytics",
        description:
          "Track enquiry types, conversion rates, and peak call times. Understand which practice areas drive the most calls.",
      },
    ],
    stats: [
      { value: "24/7", label: "lead capture — enquiries don't wait for business hours" },
      { value: "85%", label: "of callers who reach voicemail never call a law firm back" },
      { value: "$1,200+", label: "average value of a new legal client" },
      { value: "100%", label: "Australian-hosted data for solicitor-client privilege" },
    ],
    faqs: [
      {
        question: "How does the AI handle solicitor-client confidentiality?",
        answer:
          "The AI never shares information between callers and operates under strict data isolation. All data is hosted in Sydney, Australia, ensuring solicitor-client privilege is maintained under Australian law. No data is transferred offshore.",
      },
      {
        question: "Can it handle different practice areas (family, criminal, commercial)?",
        answer:
          "Yes. During setup, you specify your practice areas and the AI tailors its intake questions accordingly. It asks different questions for a family law enquiry vs a commercial dispute, ensuring you get the right information upfront.",
      },
      {
        question: "What happens with conflict-of-interest checks?",
        answer:
          "The AI captures the caller's name, opposing party details, and matter type. This information is flagged in your dashboard for your team to run a proper conflicts check before proceeding. The AI does not provide legal advice or confirm whether a conflict exists.",
      },
      {
        question: "Does it give legal advice to callers?",
        answer:
          "Absolutely not. The AI is explicitly trained to never provide legal advice, opinions, or case assessments. It captures information, schedules consultations, and directs callers to speak with a solicitor for any legal questions.",
      },
      {
        question: "Can it handle calls from existing clients checking on their case?",
        answer:
          "The AI can take a message with the client's name and matter reference for your team to follow up. For case status updates, it politely directs clients to contact their solicitor directly or offers to schedule a callback.",
      },
    ],
    ctaTitle: "Never miss a potential client again",
    ctaDescription:
      "85% of callers who reach voicemail never call back. Start your 14-day free trial and capture every legal enquiry, 24/7.",
  },
  {
    slug: "home-services",
    name: "Home Services",
    icon: "Wrench",
    color: "amber",
    heroTitle: "An AI receptionist for plumbers, electricians, and tradies",
    heroSubtitle:
      "Answer calls while you're on the job. Capture job details, handle emergency dispatch, and book appointments — without missing a beat.",
    features: [
      {
        icon: "ClipboardList",
        title: "Job Detail Capture",
        description:
          "Captures what's broken, the address, urgency level, and access instructions. All the details you need before rolling a truck.",
      },
      {
        icon: "Zap",
        title: "Emergency Dispatch",
        description:
          "Detects emergencies — burst pipes, power outages, gas leaks — and calls your mobile immediately with the job details.",
      },
      {
        icon: "Calendar",
        title: "Booking & Scheduling",
        description:
          "Books jobs into your calendar around existing appointments. Sends the customer an SMS confirmation with your arrival window.",
      },
      {
        icon: "Clock",
        title: "After-Hours Handling",
        description:
          "Answers calls at 2am when a pipe bursts. Takes the details, assesses urgency, and either dispatches you or schedules for morning.",
      },
      {
        icon: "MessageSquare",
        title: "Quote Follow-Up SMS",
        description:
          "Sends callers an SMS with next steps when you can't take the call. Keeps the job alive until you can call back with a quote.",
      },
      {
        icon: "MapPin",
        title: "Service Area Awareness",
        description:
          "Knows your service area and tells callers upfront whether you cover their suburb. No wasted trips or awkward callbacks.",
      },
    ],
    stats: [
      { value: "47%", label: "more bookings with instant SMS text-back" },
      { value: "$450", label: "average revenue lost per missed service call" },
      { value: "73%", label: "of homeowners hire the first tradie who answers" },
      { value: "24/7", label: "emergency call handling — nights, weekends, holidays" },
    ],
    faqs: [
      {
        question: "I'm on a job all day — how do I know what calls came in?",
        answer:
          "Every call is logged with a full transcript, caller details, job description, and urgency level. You get an SMS notification for urgent calls and can review everything in your dashboard when you have a break. Think of it as a second pair of hands on the phone.",
      },
      {
        question: "Can it tell the difference between an emergency and a routine job?",
        answer:
          "Yes. The AI is trained on trade-specific urgency signals — burst pipes, electrical faults, gas smells, no hot water. Emergencies get escalated immediately (call transfer or priority SMS). Routine jobs get booked into your next available slot.",
      },
      {
        question: "What if a customer wants a quote over the phone?",
        answer:
          "The AI captures all the job details (what's broken, location, photos if they text them) and lets the caller know you'll follow up with a quote. It doesn't guess pricing — it gets you the information you need to quote accurately.",
      },
      {
        question: "Does it work for a one-person operation or just big companies?",
        answer:
          "It's built for tradies and small crews. One-person operations are our sweet spot — you're the one who can't answer the phone because you're elbow-deep in a job. No minimum team size, no enterprise-only features.",
      },
      {
        question: "Can I set different responses for business hours vs after hours?",
        answer:
          "Yes. You configure your business hours and the AI adjusts automatically. During hours, it books jobs and transfers urgent calls. After hours, it takes messages, handles genuine emergencies, and lets callers know when to expect a callback.",
      },
    ],
    ctaTitle: "Stop losing jobs to missed calls",
    ctaDescription:
      "73% of homeowners hire the first tradie who answers the phone. Start your 14-day free trial and never miss a job again.",
  },
  {
    slug: "real-estate",
    name: "Real Estate",
    icon: "Home",
    color: "emerald",
    heroTitle: "An AI receptionist that never misses a property enquiry",
    heroSubtitle:
      "Capture every lead, schedule inspections, and qualify buyers — around the clock. Built for Australian real estate agents and property managers.",
    features: [
      {
        icon: "Users",
        title: "Lead Qualification",
        description:
          "Asks the right questions — budget, timeline, pre-approval status, property preferences. Qualified leads land in your dashboard ready to follow up.",
      },
      {
        icon: "Calendar",
        title: "Inspection Scheduling",
        description:
          "Books property inspections directly into your calendar. Sends the buyer an SMS confirmation with the property address and time.",
      },
      {
        icon: "Home",
        title: "Property Enquiry Handling",
        description:
          "Answers questions about listed properties — price guide, features, inspection times — based on the details you provide during setup.",
      },
      {
        icon: "Phone",
        title: "24/7 Lead Capture",
        description:
          "Property seekers browse at night and on weekends. Capture enquiries from portal listings (Domain, REA) whenever they call.",
      },
      {
        icon: "PhoneForwarded",
        title: "Hot Lead Transfers",
        description:
          "Detects high-intent buyers — pre-approved, ready to offer, asking about contracts — and transfers them to your mobile immediately.",
      },
      {
        icon: "BarChart3",
        title: "Enquiry Analytics",
        description:
          "Track which properties generate the most calls, peak enquiry times, and buyer demographics. Data-driven listing strategy.",
      },
    ],
    stats: [
      { value: "78%", label: "of property enquiries happen outside business hours" },
      { value: "$2,800+", label: "average commission per residential sale in AU" },
      { value: "24/7", label: "lead capture from Domain, REA, and direct calls" },
      { value: "3x", label: "more inspections booked with instant response" },
    ],
    faqs: [
      {
        question: "Can it answer questions about specific properties I have listed?",
        answer:
          "Yes. During setup, you provide details for your current listings — price guide, key features, inspection times, and any other information you want shared. The AI uses this to answer caller questions accurately. You can update listing details anytime from your dashboard.",
      },
      {
        question: "How does it handle rental vs sales enquiries?",
        answer:
          "The AI distinguishes between rental and sales calls based on the caller's questions. It captures the relevant details for each — rental applications vs buyer qualification — and routes them to the right person on your team if needed.",
      },
      {
        question: "Will it schedule property inspections automatically?",
        answer:
          "Yes. The AI books inspections into your calendar, checks for conflicts, and sends the buyer an SMS confirmation with the property address, time, and any access instructions. You can set available inspection windows per property.",
      },
      {
        question: "What happens when a buyer wants to make an offer?",
        answer:
          "The AI never negotiates or accepts offers. It captures the buyer's details and intent, flags the call as high-priority, and either transfers to your mobile immediately or sends you a priority notification to call back. You handle all negotiations directly.",
      },
      {
        question: "Does it work for property management as well?",
        answer:
          "Yes. For property managers, the AI handles tenant maintenance requests (captures the issue, urgency, and access details), rental enquiries, and inspection bookings. It can distinguish between emergency maintenance (flooding, no power) and routine requests.",
      },
    ],
    ctaTitle: "Capture every property lead, day and night",
    ctaDescription:
      "78% of property enquiries happen outside business hours. Start your 14-day free trial and never miss a buyer again.",
  },
];

export function getIndustryBySlug(slug: string): IndustryPage | undefined {
  return INDUSTRY_PAGES.find((page) => page.slug === slug);
}
