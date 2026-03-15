/**
 * Audio device selection utilities
 * Handles enumeration, selection, and persistence of audio input/output devices
 */

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: "audioinput" | "audiooutput";
}

const STORAGE_KEY_MIC = "phondo-selected-microphone";
const STORAGE_KEY_SPEAKER = "phondo-selected-speaker";

/**
 * Request microphone permission to enable device enumeration
 * Browser requires permission before showing device labels
 */
export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop the stream immediately - we just needed permission
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all available audio devices (microphones and speakers)
 * Note: Device labels may be empty if permission hasn't been granted
 */
export async function getAudioDevices(): Promise<{
  microphones: AudioDevice[];
  speakers: AudioDevice[];
}> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return { microphones: [], speakers: [] };
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();

    const microphones: AudioDevice[] = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`,
        kind: "audioinput" as const,
      }));

    const speakers: AudioDevice[] = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Speaker ${index + 1}`,
        kind: "audiooutput" as const,
      }));

    return { microphones, speakers };
  } catch {
    return { microphones: [], speakers: [] };
  }
}

/**
 * Save selected microphone device ID to localStorage
 */
export function saveSelectedMicrophone(deviceId: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY_MIC, deviceId);
  }
}

/**
 * Get previously selected microphone device ID from localStorage
 */
export function getSelectedMicrophone(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem(STORAGE_KEY_MIC);
}

/**
 * Save selected speaker device ID to localStorage
 */
export function saveSelectedSpeaker(deviceId: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY_SPEAKER, deviceId);
  }
}

/**
 * Get previously selected speaker device ID from localStorage
 */
export function getSelectedSpeaker(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem(STORAGE_KEY_SPEAKER);
}

/**
 * Check if a device is still available (e.g., wasn't unplugged)
 */
export async function isDeviceAvailable(deviceId: string): Promise<boolean> {
  const { microphones, speakers } = await getAudioDevices();
  const allDevices = [...microphones, ...speakers];
  return allDevices.some((d) => d.deviceId === deviceId);
}

/**
 * Set the audio output device for an HTMLAudioElement
 * Note: This is only supported in some browsers (Chrome, Edge)
 */
export async function setAudioOutputDevice(
  audioElement: HTMLAudioElement,
  deviceId: string
): Promise<boolean> {
  if (typeof audioElement.setSinkId === "function") {
    try {
      await audioElement.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check if the browser supports audio output device selection
 */
export function supportsOutputDeviceSelection(): boolean {
  if (typeof HTMLAudioElement === "undefined") {
    return false;
  }
  const audio = document.createElement("audio");
  return typeof audio.setSinkId === "function";
}
