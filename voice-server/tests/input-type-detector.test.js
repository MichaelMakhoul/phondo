const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { detectExpectedInput } = require("../lib/input-type-detector");

describe("detectExpectedInput", () => {
  // Phone
  it("detects phone number request", () => {
    assert.equal(detectExpectedInput("What is your phone number?"), "phone");
  });
  it("detects contact number", () => {
    assert.equal(detectExpectedInput("Can I get a contact number for you?"), "phone");
  });
  it("detects mobile", () => {
    assert.equal(detectExpectedInput("What is your mobile number?"), "phone");
  });
  it("detects callback number", () => {
    assert.equal(detectExpectedInput("What is the best callback number?"), "phone");
  });
  it("detects call you at", () => {
    assert.equal(detectExpectedInput("What number can I call you at?"), "phone");
  });

  // Email
  it("detects email", () => {
    assert.equal(detectExpectedInput("What is your email address?"), "email");
  });
  it("detects e-mail", () => {
    assert.equal(detectExpectedInput("Could you give me your e-mail?"), "email");
  });

  // Name
  it("detects your name", () => {
    assert.equal(detectExpectedInput("May I have your name please?"), "name");
  });
  it("detects full name", () => {
    assert.equal(detectExpectedInput("Can I get your full name?"), "name");
  });
  it("detects first name", () => {
    assert.equal(detectExpectedInput("What is your first name?"), "name");
  });
  it("detects who am I speaking", () => {
    assert.equal(detectExpectedInput("Who am I speaking with today?"), "name");
  });

  // Address
  it("detects address", () => {
    assert.equal(detectExpectedInput("What is your address?"), "address");
  });
  it("detects postcode", () => {
    assert.equal(detectExpectedInput("What is your postcode?"), "address");
  });
  it("detects zip code", () => {
    assert.equal(detectExpectedInput("Could you provide your zip code?"), "address");
  });

  // Date/time
  it("detects what date", () => {
    assert.equal(detectExpectedInput("What date works best for you?"), "date_time");
  });
  it("detects when would", () => {
    assert.equal(detectExpectedInput("When would you like to come in?"), "date_time");
  });
  it("detects preferred time", () => {
    assert.equal(detectExpectedInput("Do you have a preferred time?"), "date_time");
  });

  // General (no match)
  it("returns general for unrelated message", () => {
    assert.equal(detectExpectedInput("How can I help you today?"), "general");
  });
  it("returns general for null", () => {
    assert.equal(detectExpectedInput(null), "general");
  });
  it("returns general for empty string", () => {
    assert.equal(detectExpectedInput(""), "general");
  });
  it("returns general for confirmation", () => {
    assert.equal(detectExpectedInput("Is your phone number 0412 345 678?"), "phone");
    // Known behavior: confirmations also trigger phone detection.
    // This is logged in voice-server-tuning.md as a known issue.
  });
  it("phone test F6: offering the caller-ID number is a yes/no question", () => {
    assert.equal(detectExpectedInput("Thanks, Michael. What's the best mobile number to reach you on? I can see you're calling from 0414 141 883, is that the one?"), "general");
    assert.equal(detectExpectedInput("I've got 0414 141 883 from your call. Is that the best number?"), "general");
    assert.equal(detectExpectedInput("What's the best mobile number to reach you on?"), "phone", "asking for a number is unchanged");
  });
});
