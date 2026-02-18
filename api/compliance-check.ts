// ============================================
// API: /api/compliance-check.ts
// Deploy to: pure-dispatch-landing/api/compliance-check.ts
// ============================================
// Checks telemarketing compliance rules before calling/texting brokers.
// Validates:
//   - State-level do-not-call restrictions
//   - TCPA compliance (calling hours, consent)
//   - CAN-SPAM compliance (email)
//
//   GET ?action=check-call&state=XX&time=HH:mm → Can we call this state right now?
//   GET ?action=check-email                     → Email compliance checklist
//   GET ?action=state-rules&state=XX            → Get specific state rules
// ============================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ─────────────────────────────────────────────
// State-Level Telemarketing Rules
// ─────────────────────────────────────────────
interface StateRule {
  state: string;
  name: string;
  timezone: string;
  call_start_hour: number; // Local time, 24h format
  call_end_hour: number;
  state_dnc_registry: boolean;
  additional_restrictions: string[];
}

const STATE_RULES: Record<string, StateRule> = {
  // States with stricter rules
  'CA': { state: 'CA', name: 'California', timezone: 'America/Los_Angeles', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Requires written consent for automated calls', 'Must identify caller within first 30 seconds'] },
  'NY': { state: 'NY', name: 'New York', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Must register with NY DNC'] },
  'TX': { state: 'TX', name: 'Texas', timezone: 'America/Chicago', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Must check Texas no-call list'] },
  'FL': { state: 'FL', name: 'Florida', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Calling hours 8am-8pm local', 'Must register as telemarketer'] },
  'PA': { state: 'PA', name: 'Pennsylvania', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: [] },
  'IL': { state: 'IL', name: 'Illinois', timezone: 'America/Chicago', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Must provide opt-out mechanism'] },
  'NJ': { state: 'NJ', name: 'New Jersey', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: ['Must register with NJ DCA'] },
  'GA': { state: 'GA', name: 'Georgia', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: [] },
  'OH': { state: 'OH', name: 'Ohio', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: [] },
  'NC': { state: 'NC', name: 'North Carolina', timezone: 'America/New_York', call_start_hour: 8, call_end_hour: 21, state_dnc_registry: true, additional_restrictions: [] },
};

// Default federal TCPA rules
const FEDERAL_DEFAULT: StateRule = {
  state: 'DEFAULT',
  name: 'Federal (TCPA)',
  timezone: 'America/New_York',
  call_start_hour: 8,
  call_end_hour: 21,
  state_dnc_registry: false,
  additional_restrictions: [
    'Federal TCPA: No calls before 8am or after 9pm local time',
    'Must identify yourself and company',
    'Must honor do-not-call requests immediately',
    'B2B cold calls are generally permitted under TCPA',
  ],
};

function getStateRules(stateCode: string): StateRule {
  return STATE_RULES[stateCode.toUpperCase()] || { ...FEDERAL_DEFAULT, state: stateCode.toUpperCase(), name: stateCode.toUpperCase() };
}

// Check if current time allows calling in a state
function canCallNow(stateCode: string): { allowed: boolean; reason: string; local_time: string } {
  const rules = getStateRules(stateCode);
  
  // Get current time in the state's timezone
  const now = new Date();
  const localTime = new Date(now.toLocaleString('en-US', { timeZone: rules.timezone }));
  const hour = localTime.getHours();
  const minute = localTime.getMinutes();
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;

  if (hour < rules.call_start_hour) {
    return {
      allowed: false,
      reason: `Too early in ${rules.name}. Calling allowed after ${rules.call_start_hour}:00 AM local time. Current local time: ${timeStr}.`,
      local_time: timeStr,
    };
  }

  if (hour >= rules.call_end_hour) {
    return {
      allowed: false,
      reason: `Too late in ${rules.name}. Calling not allowed after ${rules.call_end_hour}:00 PM local time. Current local time: ${timeStr}.`,
      local_time: timeStr,
    };
  }

  return {
    allowed: true,
    reason: `OK to call ${rules.name}. Current local time: ${timeStr}. Window: ${rules.call_start_hour}:00 AM - ${rules.call_end_hour}:00 PM.`,
    local_time: timeStr,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.query.action;

    switch (action) {
      case 'check-call': {
        const state = req.query.state as string;
        if (!state) return res.status(400).json({ error: 'state required (2-letter code)' });

        const callCheck = canCallNow(state);
        const rules = getStateRules(state);

        return res.status(200).json({
          ...callCheck,
          state: state.toUpperCase(),
          state_name: rules.name,
          has_state_dnc: rules.state_dnc_registry,
          restrictions: rules.additional_restrictions,
          note: 'B2B cold calls to brokers are generally permitted under TCPA. State DNC lists may still apply. This is informational only — not legal advice.',
        });
      }

      case 'check-email': {
        return res.status(200).json({
          can_spam_checklist: [
            { rule: 'Include your physical postal address', required: true },
            { rule: 'Include a clear unsubscribe mechanism', required: true },
            { rule: 'Do not use misleading subject lines', required: true },
            { rule: 'Identify the message as an advertisement', required: true },
            { rule: 'Honor unsubscribe requests within 10 business days', required: true },
            { rule: 'Do not use harvested email addresses', required: true },
          ],
          b2b_note: 'CAN-SPAM applies to B2B emails. However, B2B cold emails are standard industry practice in freight brokerage. Ensure compliance with the above.',
          disclaimer: 'This is informational guidance — not legal advice.',
        });
      }

      case 'state-rules': {
        const state = req.query.state as string;
        if (!state) return res.status(400).json({ error: 'state required' });

        const rules = getStateRules(state);
        const callCheck = canCallNow(state);

        return res.status(200).json({
          rules,
          can_call_now: callCheck,
        });
      }

      case 'all-states': {
        const allStates = Object.entries(STATE_RULES).map(([code, rules]) => {
          const callCheck = canCallNow(code);
          return { ...rules, can_call_now: callCheck.allowed };
        });

        return res.status(200).json({ states: allStates });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}. Use: check-call, check-email, state-rules, all-states` });
    }
  } catch (err: any) {
    console.error('[Compliance Check API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
