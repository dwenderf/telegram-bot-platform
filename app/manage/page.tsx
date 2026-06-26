'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

export default function ManageRoot() {
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        router.replace('/manage/dashboard');
      } else {
        router.replace('/manage/login');
      }
    });
  }, [router]);

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#080c14', color: '#94a3b8' }}>
      <div style={{ fontSize: '1rem', fontWeight: 500 }}>Initializing session...</div>
    </div>
  );
}
