'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import '../manage.css';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Agent Platform';

interface Entity {
  id: string;
  slug: string;
  display_name: string;
  owner_profile_id: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/manage/login');
      } else {
        setUser(session.user);
        fetchEntities();
      }
    });
  }, [router]);

  const fetchEntities = async () => {
    try {
      const { data, error } = await supabase
        .from('entities')
        .select('id, slug, display_name, owner_profile_id')
        .order('display_name');

      if (error) throw error;
      setEntities(data || []);
    } catch (err: any) {
      console.error('Error fetching entities:', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/manage/login');
  };

  const handleCreateEntity = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormLoading(true);
    setFormError('');

    try {
      const slugVal = newSlug.trim().toLowerCase();
      if (!slugVal || !newDisplayName.trim()) {
        throw new Error('Please fill in all fields.');
      }

      const { error } = await supabase
        .from('entities')
        .insert({
          display_name: newDisplayName.trim(),
          slug: slugVal,
        });

      if (error) throw error;

      setShowModal(false);
      setNewDisplayName('');
      setNewSlug('');
      fetchEntities();
    } catch (err: any) {
      setFormError(err.message || 'Failed to create entity.');
    } finally {
      setFormLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#080c14', color: '#94a3b8' }}>
        <div>Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="manage-container">
      <header className="manage-header">
        <div className="brand">{APP_NAME}</div>
        <div className="user-badge">
          <span style={{ marginRight: '1rem' }}>{user?.email}</span>
          <button onClick={handleSignOut} className="btn-signout">Sign Out</button>
        </div>
      </header>

      <main style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <h2>My Tenant Directories</h2>
          <button onClick={() => setShowModal(true)} className="btn btn-primary">Create Entity</button>
        </div>

        {entities.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p style={{ marginBottom: '1.5rem' }}>No entities found. Create an entity to get started.</p>
            <button onClick={() => setShowModal(true)} className="btn btn-primary">Create Entity</button>
          </div>
        ) : (
          <div className="grid">
            {entities.map((entity) => {
              const isOwner = entity.owner_profile_id === user?.id;
              return (
                <Link key={entity.id} href={`/manage/entities/${entity.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="card card-interactive">
                    <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '1rem' }}>
                      <span>{entity.display_name}</span>
                      <span className={`badge ${isOwner ? 'badge-owner' : 'badge-viewer'}`} style={{ fontSize: '0.675rem' }}>
                        {isOwner ? 'Owner' : 'Member'}
                      </span>
                    </h3>
                    <p style={{ fontSize: '0.875rem', marginBottom: 0 }}>Slug: <code>{entity.slug}</code></p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>

      {showModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div className="card" style={{ maxWidth: '500px', width: '100%', margin: '1rem' }}>
            <h2>Create New Entity</h2>
            {formError && <div className="alert alert-error">{formError}</div>}
            <form onSubmit={handleCreateEntity}>
              <div className="form-group">
                <label className="form-label" htmlFor="displayName">Display Name</label>
                <input
                  id="displayName"
                  type="text"
                  placeholder="e.g. Acme Corp"
                  className="form-control"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="slug">Slug</label>
                <input
                  id="slug"
                  type="text"
                  placeholder="e.g. acme-corp"
                  className="form-control"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  required
                />
              </div>
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end', marginTop: '2rem' }}>
                <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={formLoading}>
                  {formLoading ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
