import { describe, it, expect } from "vitest";
import { parseBusinessHours } from "../parse-business-hours";

// SCRUM-515. These hours are what the AI books against. Parsing a day WRONG
// books a caller into a closed business; refusing to parse it leaves the
// sensible Mon-Fri 9-5 default and the owner fixes it in Settings. So the whole
// module is biased toward refusing, and most of these tests are about refusing.

const CLOSED_WEEK = { saturday: null, sunday: null };

describe("parseBusinessHours — what a real site says", () => {
  it("reads the dealership hours that started this ticket", () => {
    const result = parseBusinessHours([
      "Monday: 8:30am - 5:30pm",
      "Tuesday: 8:30am - 5:30pm",
      "Wednesday: 8:30am - 5:30pm",
      "Thursday: 8:30am - 9:00pm",
      "Friday: 8:30am - 5:30pm",
      "Saturday: 8:30am - 5:00pm",
      "Sunday: Closed",
    ]);

    expect(result).not.toBeNull();
    expect(result!.hours).toEqual({
      monday: { open: "08:30", close: "17:30" },
      tuesday: { open: "08:30", close: "17:30" },
      wednesday: { open: "08:30", close: "17:30" },
      thursday: { open: "08:30", close: "21:00" }, // late night, not 17:30
      friday: { open: "08:30", close: "17:30" },
      saturday: { open: "08:30", close: "17:00" },
      sunday: null,
    });
  });

  it("expands a day range", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Sat: 10am - 2pm", "Sun: Closed"]);

    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.friday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.saturday).toEqual({ open: "10:00", close: "14:00" });
    expect(result!.hours.sunday).toBeNull();
  });

  it("expands a wrap-around range", () => {
    const result = parseBusinessHours(["Saturday to Sunday: 10am - 4pm", "Mon-Fri: Closed"]);
    expect(result!.hours.saturday).toEqual({ open: "10:00", close: "16:00" });
    expect(result!.hours.sunday).toEqual({ open: "10:00", close: "16:00" });
    expect(result!.hours.wednesday).toBeNull();
  });

  it("handles a comma-separated day list", () => {
    const result = parseBusinessHours(["Mon, Wed, Fri: 9:00 - 17:00", "Tue, Thu: Closed"]);
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.wednesday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.friday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.tuesday).toBeNull();
    // Weekend never mentioned, and five days were named, so: closed.
    expect(result!.hours.sunday).toBeNull();
  });

  it("accepts 24-hour times, dots, and 'to'", () => {
    const a = parseBusinessHours(["Mon-Fri: 08:30 to 17:30"]);
    const b = parseBusinessHours(["Mon-Fri: 8.30am – 5.30pm"]);
    expect(a!.hours.monday).toEqual({ open: "08:30", close: "17:30" });
    expect(b!.hours.monday).toEqual({ open: "08:30", close: "17:30" });
  });

  it("collapses a lunch break to the outer envelope", () => {
    // The column holds one interval per day. A lunch break is a blocked time,
    // not a closed business — pretending the afternoon doesn't exist would
    // refuse real bookings.
    const result = parseBusinessHours(["Mon-Fri: 9am - 12pm, 1pm - 5pm"]);
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
  });

  it("repairs the unambiguous bare '9 - 5'", () => {
    const result = parseBusinessHours(["Mon-Fri: 9 - 5"]);
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
  });

  it("understands noon and midday", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Saturday: 9am - noon"]);
    expect(result!.hours.saturday).toEqual({ open: "09:00", close: "12:00" });
  });

  it("reads 'By appointment only' as closed rather than guessing", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Saturday: By appointment only"]);
    expect(result!.hours.saturday).toBeNull();
  });

  it("reads a closed day through trailing punctuation", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Saturday: Closed.", "Sunday: Closed;"]);
    expect(result!.hours.saturday).toBeNull();
    expect(result!.hours.sunday).toBeNull();
  });

  it("accepts compact 24-hour times", () => {
    const result = parseBusinessHours(["Mon-Fri: 0830 - 1730"]);
    expect(result!.hours.monday).toEqual({ open: "08:30", close: "17:30" });
  });

  it("understands midday and midnight", () => {
    const a = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Saturday: 9am - midday"]);
    expect(a!.hours.saturday).toEqual({ open: "09:00", close: "12:00" });
    const b = parseBusinessHours(["Mon-Fri: 6pm - midnight"]);
    // 18:00 - 00:00 closes before it opens: overnight, out of scope.
    expect(b).toBeNull();
  });

  it("keeps a bare range whose close cannot be a morning", () => {
    // "9 - 12" reads only one way: 9pm to 12pm is not a window.
    const result = parseBusinessHours(["Mon-Fri: 9 - 12"]);
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "12:00" });
  });
});

describe("parseBusinessHours — refuses rather than guess", () => {
  it("returns null for nothing to parse", () => {
    expect(parseBusinessHours([])).toBeNull();
    expect(parseBusinessHours(undefined)).toBeNull();
    expect(parseBusinessHours(null)).toBeNull();
    expect(parseBusinessHours(["   "])).toBeNull();
  });

  it("returns null when ANY line is unintelligible", () => {
    // A silently dropped Thursday reads as "closed Thursday" to the booking
    // engine. A partially understood week is not a week.
    expect(
      parseBusinessHours([
        "Mon-Wed: 9am - 5pm",
        "Thursday: open late, call us",
        "Friday: 9am - 5pm",
        "Sat-Sun: Closed",
      ])
    ).toBeNull();
  });

  it("refuses a line that states hours AND a closed token, rather than closing the day", () => {
    // "closed for lunch" is not "closed". Reading the token as the whole
    // answer marks a plainly-open Monday shut, counts as a SUCCESSFUL parse,
    // and so never lands in `unparsed` and never warns the owner.
    expect(
      parseBusinessHours([
        "Monday: 9am - 5pm, closed for lunch 1-2pm",
        "Tue-Fri: 9am - 5pm",
        "Sat-Sun: Closed",
      ])
    ).toBeNull();

    expect(
      parseBusinessHours([
        "Mon-Fri: 9am - 5pm",
        "Saturday: 9am - 1pm, or by appointment",
        "Sunday: Closed",
      ])
    ).toBeNull();

    expect(parseBusinessHours(["Mon-Fri: 9-5 (closed public holidays)"])).toBeNull();
  });

  it("returns null for a bare range that reads sensibly as morning OR evening", () => {
    // "5 - 11" is a bakery at 5am or a bar at 5pm. Guessing AM is the one
    // guess that offers slots while the business is shut.
    expect(parseBusinessHours(["Mon-Fri: 5 - 11"])).toBeNull();
    expect(parseBusinessHours(["Mon-Fri: 6 - 10"])).toBeNull();
    // Same trap inside a second window: envelope collapse would otherwise
    // report Monday as open 01:00 - 12:00.
    expect(parseBusinessHours(["Mon-Fri: 9 - 12, 1 - 5"])).toBeNull();
  });

  it("returns null for prose it cannot anchor to a day", () => {
    expect(parseBusinessHours(["We are open most days, please call ahead"])).toBeNull();
    expect(parseBusinessHours(["Open 7 days"])).toBeNull();
  });

  it("returns null for '24 hours' rather than inventing 00:00-23:59", () => {
    // No open-close pair to read, so the line is unintelligible and the whole
    // week is refused. Inventing 00:00-23:59 would lie about one end of the day.
    expect(parseBusinessHours(["Monday: Open 24 hours", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
    expect(parseBusinessHours(["Mon-Sun: 24/7"])).toBeNull();
  });

  it("returns null when a day is given two conflicting sets of times", () => {
    expect(parseBusinessHours(["Monday: 9am - 5pm", "Monday: 10am - 4pm", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
  });

  it("tolerates a day repeated with the SAME times", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm", "Monday: 9am - 5pm"]);
    expect(result).not.toBeNull();
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
  });

  it("returns null when close is not after open", () => {
    expect(parseBusinessHours(["Monday: 5pm - 9am", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull(); // overnight: out of scope
    expect(parseBusinessHours(["Monday: 9am - 9am", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
    expect(parseBusinessHours(["Monday: 11pm - 2am", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
  });

  it("returns null for impossible clock values", () => {
    expect(parseBusinessHours(["Monday: 25:00 - 26:00", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
    expect(parseBusinessHours(["Monday: 9:75am - 5pm", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
    expect(parseBusinessHours(["Monday: 13pm - 5pm", "Tue-Fri: 9am - 5pm", "Sat-Sun: Closed"])).toBeNull();
  });

  it("returns null when every listed day is closed", () => {
    // Nothing useful, and almost certainly a misread page.
    expect(parseBusinessHours(["Mon-Sun: Closed"])).toBeNull();
  });

  it("returns null for a bare time range with no day", () => {
    expect(parseBusinessHours(["9am - 5pm"])).toBeNull();
  });

  it("refuses to close five days because the site only mentioned one", () => {
    // The hours live in an image and the scraper found a single line. Marking
    // Tue-Sun closed would have the assistant turn callers away six days a week
    // for a business that is open — worse than the default it replaced, and
    // nothing would prompt the owner to look.
    expect(parseBusinessHours(["Monday: 9am - 5pm"])).toBeNull();
    expect(parseBusinessHours(["Sat: 10am - 2pm", "Sun: 10am - 2pm"])).toBeNull();
    expect(parseBusinessHours(["Mon: 9am-5pm", "Wed: 9am-5pm", "Fri: 9am-5pm"])).toBeNull();
  });

  it("accepts a plain Mon-Fri office and closes the weekend", () => {
    // Five named days is the line, and the commonest real listing clears it.
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm"]);
    expect(result).not.toBeNull();
    expect(result!.hours.monday).toEqual({ open: "09:00", close: "17:00" });
    expect(result!.hours.saturday).toBeNull();
    expect(result!.hours.sunday).toBeNull();
  });

  it("counts explicitly-closed days toward a complete week", () => {
    const result = parseBusinessHours(["Mon-Thu: 8am - 6pm", "Fri: 8am - 1pm", "Sat-Sun: Closed"]);
    expect(result).not.toBeNull();
    expect(result!.hours.friday).toEqual({ open: "08:00", close: "13:00" });
    expect(result!.hours.saturday).toBeNull();
  });

  it("does not treat an unknown word as a day", () => {
    expect(parseBusinessHours(["Holidays: 9am - 5pm", "Mon-Fri: 9am - 5pm"])).toBeNull();
    expect(parseBusinessHours(["Public Holiday: Closed", "Mon-Fri: 9am - 5pm"])).toBeNull();
  });
});

describe("parseBusinessHours — output is exactly the DB shape", () => {
  it("always names all seven days", () => {
    const result = parseBusinessHours(["Mon-Fri: 9am - 5pm"]);
    expect(Object.keys(result!.hours).sort()).toEqual(
      ["friday", "monday", "saturday", "sunday", "thursday", "tuesday", "wednesday"].sort()
    );
    expect(result!.hours).toMatchObject(CLOSED_WEEK);
  });

  it("emits zero-padded 24-hour HH:MM", () => {
    const result = parseBusinessHours(["Mon-Fri: 8am - 6pm"]);
    expect(result!.hours.monday).toEqual({ open: "08:00", close: "18:00" });
  });

  it("cannot throw on hostile input", () => {
    const nasty = [null, undefined, 42, {}, [], "::::", "Monday:", "-", "Monday: -"] as unknown as string[];
    expect(() => parseBusinessHours(nasty)).not.toThrow();
    expect(parseBusinessHours(nasty)).toBeNull();
  });
});
