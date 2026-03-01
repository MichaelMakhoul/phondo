const { getSupabase } = require("./supabase");

/**
 * Look up the answer mode for a phone number.
 * Returns { answerMode, ringFirstNumber, ringFirstTimeout } or null.
 */
async function getAnswerMode(calledNumber) {
  const supabase = getSupabase();

  // Look up the phone number
  const { data: phone, error: phoneError } = await supabase
    .from("phone_numbers")
    .select("assistant_id")
    .eq("phone_number", calledNumber)
    .eq("is_active", true)
    .single();

  if (phoneError || !phone || !phone.assistant_id) return null;

  // Get assistant settings
  const { data: assistant, error: assistantError } = await supabase
    .from("assistants")
    .select("settings")
    .eq("id", phone.assistant_id)
    .single();

  if (assistantError || !assistant) return null;

  const settings = assistant.settings || {};
  if (settings.answerMode !== "ring_first") return null;

  const ringFirstNumber = settings.ringFirstNumber;
  if (!ringFirstNumber || !/^\+\d{7,15}$/.test(ringFirstNumber)) return null;

  const ringFirstTimeout = Math.max(5, Math.min(60, settings.ringFirstTimeout || 20));

  return { answerMode: "ring_first", ringFirstNumber, ringFirstTimeout };
}

module.exports = { getAnswerMode };
