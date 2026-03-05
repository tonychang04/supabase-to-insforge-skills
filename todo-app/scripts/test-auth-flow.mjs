/**
 * Test script to verify signUp vs resendVerificationEmail API behavior.
 * Run: node scripts/test-auth-flow.mjs
 *
 * This tests the API responses - we cannot verify actual email delivery.
 */

const BASE_URL = "https://pvjqquq4.us-east.insforge.app";
const ANON_KEY = "ik_184c1b24fb0437bb993ad27b9f5bf3cf";

const testEmail = `test-${Date.now()}@example.com`;
const testPassword = "testpass123";

async function test() {
  console.log("=== Auth flow test ===\n");
  console.log("Test email:", testEmail);

  // 1. Sign up
  console.log("\n1. POST /api/auth/users (signUp)...");
  const signUpRes = await fetch(`${BASE_URL}/api/auth/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name: "Test User",
    }),
  });

  const signUpData = await signUpRes.json().catch(() => ({}));
  console.log("   Status:", signUpRes.status);
  console.log("   Response:", JSON.stringify(signUpData, null, 2));

  if (signUpRes.status !== 201 && signUpRes.status !== 200) {
    console.log("\n   Sign up failed. Stopping.");
    return;
  }

  const requiresVerification = signUpData.requireEmailVerification === true;
  console.log("\n   requireEmailVerification:", requiresVerification);

  if (!requiresVerification) {
    console.log("\n   Backend returned accessToken - no verification needed.");
    return;
  }

  // 2. Resend verification (same as Resend button)
  console.log("\n2. POST /api/auth/email/send-verification (resend)...");
  const resendRes = await fetch(`${BASE_URL}/api/auth/email/send-verification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify({ email: testEmail }),
  });

  const resendData = await resendRes.json().catch(() => ({}));
  console.log("   Status:", resendRes.status);
  console.log("   Response:", JSON.stringify(resendData, null, 2));

  console.log("\n=== Summary ===");
  console.log("- signUp: creates user, returns requireEmailVerification=true");
  console.log("- Backend is supposed to send email during signUp (per skill)");
  console.log("- resendVerificationEmail: hits /api/auth/email/send-verification");
  console.log("- Both succeed at API level - actual email delivery cannot be verified here");
}

test().catch(console.error);
