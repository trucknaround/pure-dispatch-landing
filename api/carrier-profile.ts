// ============================================
// API: /api/carrier-profile.ts
// Deploy to: pure-dispatch-landing/api/carrier-profile.ts
// ============================================
// Handles carrier profile CRUD:
//   GET    → Get current carrier's profile
//   POST   action=update → Update carrier profile
//   POST   action=create → Create initial profile (on registration)
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

function getUserId(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const token = authHeader.substring(7);
    const base64Payload = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
    
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    
    return payload.userId || null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // ═══════════════════════════════════════
    // GET — Fetch carrier profile
    // ═══════════════════════════════════════
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('carrier_profiles')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code === 'PGRST116') {
        // No profile exists yet — return empty template
        return res.status(200).json({
          profile: null,
          message: 'No carrier profile found. Create one to unlock lane targeting and broker matching.'
        });
      }
      if (error) throw error;

      return res.status(200).json({ profile: data });
    }

    // ═══════════════════════════════════════
    // POST — Create or update profile
    // ═══════════════════════════════════════
    if (req.method === 'POST') {
      const action = req.body?.action;
      const body = req.body;

      // Sanitize input — only allow known fields
      const allowedFields = [
        'company_name', 'owner_name', 'mc_number', 'dot_number',
        'email', 'phone',
        'home_base_city', 'home_base_state', 'home_base_zip',
        'home_base_lat', 'home_base_lng',
        'equipment_types', 'trailer_length', 'max_weight',
        'hazmat_endorsed', 'twic_card', 'team_driving',
        'preferred_lanes', 'preferred_states',
        'max_deadhead_miles', 'preferred_min_miles', 'preferred_max_miles',
        'revenue_target_weekly', 'revenue_target_monthly', 'min_rate_per_mile',
        'operating_radius', 'available_days', 'preferred_pickup_time'
      ];

      const profileData: Record<string, any> = {};
      for (const field of allowedFields) {
        if (body[field] !== undefined) {
          profileData[field] = body[field];
        }
      }

      if (action === 'create') {
        profileData.user_id = userId;

        const { data, error } = await supabase
          .from('carrier_profiles')
          .insert(profileData)
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            return res.status(409).json({ error: 'Profile already exists. Use action=update.' });
          }
          throw error;
        }

        return res.status(201).json({ profile: data, message: 'Carrier profile created' });
      }

      if (action === 'update') {
        const { data, error } = await supabase
          .from('carrier_profiles')
          .update(profileData)
          .eq('user_id', userId)
          .select()
          .single();

        if (error) throw error;
        return res.status(200).json({ profile: data, message: 'Carrier profile updated' });
      }

      return res.status(400).json({ error: 'action must be "create" or "update"' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err: any) {
    console.error('[Carrier Profile API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
