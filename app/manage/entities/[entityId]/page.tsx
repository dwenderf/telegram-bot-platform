'use client';

import { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import Link from 'next/link';
import '../../manage.css';

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Agent Platform';

interface Entity {
  id: string;
  slug: string;
  display_name: string;
  owner_profile_id: string;
}

interface Authorization {
  id: string;
  profile_id: string | null;
  invited_email: string | null;
  role: 'admin' | 'editor' | 'viewer';
  status: 'active' | 'pending';
  granted_by: string;
}

export default function EntityDetails({ params }: { params: Promise<{ entityId: string }> }) {
  const router = useRouter();
  const { entityId } = use(params);

  const [user, setUser] = useState<any>(null);
  const [entity, setEntity] = useState<Entity | null>(null);
  const [authorizations, setAuthorizations] = useState<Authorization[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'settings' | 'team' | 'groups'>('settings');

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [entityError, setEntityError] = useState('');
  const [entitySuccess, setEntitySuccess] = useState('');
  const [saveLoading, setSaveLoading] = useState(false);

  // Invite states
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'editor' | 'viewer'>('viewer');
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);

  // Group linking states
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState('');
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [linkedGroups, setLinkedGroups] = useState<any[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/manage/login');
      } else {
        setUser(session.user);
        loadEntityData();
      }
    });
  }, [router, entityId]);

  const loadEntityData = async () => {
    setLoading(true);
    setEntityError('');
    try {
      // 1. Fetch Entity details (filtered by RLS)
      const { data: entityData, error: entityErr } = await supabase
        .from('entities')
        .select('id, slug, display_name, owner_profile_id')
        .eq('id', entityId)
        .maybeSingle();

      if (entityErr) throw entityErr;
      if (!entityData) {
        throw new Error('Entity not found or you do not have permission to view it.');
      }

      setEntity(entityData);
      setDisplayName(entityData.display_name);

      // 2. Fetch Authorizations
      const { data: authsData, error: authsErr } = await supabase
        .from('authorizations')
        .select('id, profile_id, invited_email, role, status, granted_by')
        .eq('entity_id', entityId);

      if (authsErr) throw authsErr;
      setAuthorizations(authsData || []);

      // 3. Fetch Linked Groups (gated for owner/admin in RPC)
      const { data: { session } } = await supabase.auth.getSession();
      const sessionUser = session?.user;
      const isOwnerUser = entityData.owner_profile_id === sessionUser?.id;
      const isAdminUser = isOwnerUser || (authsData || []).some(
        (a: any) => a.profile_id === sessionUser?.id && a.role === 'admin' && a.status === 'active'
      );

      if (isAdminUser) {
        const { data: groupsData, error: groupsErr } = await supabase.rpc('list_entity_groups', {
          p_entity: entityId
        });
        if (!groupsErr) {
          setLinkedGroups(groupsData || []);
        } else {
          console.warn('Failed to load linked groups:', groupsErr);
        }
      }
    } catch (err: any) {
      setEntityError(err.message || 'Failed to load entity.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateEntity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entity) return;
    setSaveLoading(true);
    setEntityError('');
    setEntitySuccess('');

    try {
      const { error } = await supabase
        .from('entities')
        .update({ display_name: displayName.trim() })
        .eq('id', entity.id);

      if (error) throw error;
      setEntitySuccess('Settings saved successfully!');
      setEntity({ ...entity, display_name: displayName.trim() });
    } catch (err: any) {
      setEntityError(err.message || 'Failed to update settings.');
    } finally {
      setSaveLoading(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entity) return;
    setInviteLoading(true);
    setInviteError('');
    setInviteSuccess('');

    const targetEmail = inviteEmail.trim().toLowerCase();
    if (!targetEmail) return;

    try {
      // Call the secure invite_user RPC function
      const { error } = await supabase.rpc('invite_user', {
        p_entity_id: entity.id,
        p_email: targetEmail,
        p_role: inviteRole,
      });

      if (error) throw error;

      setInviteSuccess(`Successfully processed invite for ${targetEmail} as ${inviteRole}.`);
      setInviteEmail('');
      
      // Reload authorizations list
      const { data: authsData } = await supabase
        .from('authorizations')
        .select('id, profile_id, invited_email, role, status, granted_by')
        .eq('entity_id', entity.id);
      setAuthorizations(authsData || []);
    } catch (err: any) {
      setInviteError(err.message || 'Failed to send invite.');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRevoke = async (authId: string) => {
    if (!entity || !confirm('Are you sure you want to revoke this user\'s access?')) return;
    setInviteError('');
    setInviteSuccess('');

    try {
      const { error } = await supabase
        .from('authorizations')
        .delete()
        .eq('id', authId);

      if (error) throw error;

      setInviteSuccess('Access revoked successfully.');
      setAuthorizations(authorizations.filter((a) => a.id !== authId));
    } catch (err: any) {
      setInviteError(err.message || 'Failed to revoke access.');
    }
  };

  const handleGenerateCode = async () => {
    if (!entity) return;
    setLinkLoading(true);
    setLinkError('');
    setLinkSuccess('');
    try {
      const { data, error } = await supabase.rpc('mint_link_token', {
        p_entity: entity.id,
      });

      if (error) throw error;

      setLinkCode(data);
      setCopied(false);
      setTimeLeft(600); // 10 minutes in seconds
    } catch (err: any) {
      setLinkError(err.message || 'Failed to generate link code.');
    } finally {
      setLinkLoading(false);
    }
  };

  const handleCopyCommand = async () => {
    if (!linkCode) return;
    try {
      await navigator.clipboard.writeText(`/auth ${linkCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Graceful fallback: do not set copied and do not show toast
    }
  };

  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          setLinkCode(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', backgroundColor: '#080c14', color: '#94a3b8' }}>
        <div>Loading directory settings...</div>
      </div>
    );
  }

  const isOwner = entity?.owner_profile_id === user?.id;
  const isAdmin = isOwner || authorizations.some((auth) => auth.profile_id === user?.id && auth.role === 'admin' && auth.status === 'active');

  return (
    <div className="manage-container">
      <header className="manage-header" style={{ marginBottom: '2rem' }}>
        <div className="brand">
          <Link href="/manage/dashboard" style={{ textDecoration: 'none', color: 'inherit' }}>
            {APP_NAME}
          </Link>
          <span style={{ color: 'var(--text-muted)', fontSize: '1rem', fontWeight: 450 }}>
            &nbsp;/&nbsp;{entity?.display_name}
          </span>
        </div>
        <div className="user-badge">
          <span>{user?.email}</span>
        </div>
      </header>

      {entityError && (
        <div className="card">
          <div className="alert alert-error">{entityError}</div>
          <Link href="/manage/dashboard" className="btn btn-secondary">
            Back to Dashboard
          </Link>
        </div>
      )}

      {entity && (
        <>
          <div className="tabs">
            <button
              onClick={() => setActiveTab('settings')}
              className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
            >
              General Settings
            </button>
            <button
              onClick={() => setActiveTab('team')}
              className={`tab-btn ${activeTab === 'team' ? 'active' : ''}`}
            >
              Team & Access
            </button>
            {isAdmin && (
              <button
                onClick={() => setActiveTab('groups')}
                className={`tab-btn ${activeTab === 'groups' ? 'active' : ''}`}
              >
                Linked Groups
              </button>
            )}
          </div>

          {activeTab === 'settings' && (
            <div className="card">
              <h2>Directory Settings</h2>
              {entitySuccess && <div className="alert alert-success">{entitySuccess}</div>}
              
              <form onSubmit={handleUpdateEntity}>
                <div className="form-group">
                  <label className="form-label" htmlFor="dirName">Display Name</label>
                  <input
                    id="dirName"
                    type="text"
                    className="form-control"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    disabled={saveLoading}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Slug (Directory Key)</label>
                  <input
                    type="text"
                    className="form-control"
                    value={entity.slug}
                    disabled
                    style={{ opacity: 0.6 }}
                  />
                  <p style={{ fontSize: '0.825rem', marginTop: '0.5rem', marginBottom: 0 }}>
                    Slugs are unique and immutable to preserve endpoint webhook integrity.
                  </p>
                </div>
                <button type="submit" className="btn btn-primary" disabled={saveLoading}>
                  {saveLoading ? 'Saving...' : 'Save Settings'}
                </button>
              </form>
            </div>
          )}

          {activeTab === 'team' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              {/* Owner-only panel to invite users */}
              {isOwner && (
                <div className="card">
                  <h2>Invite Team Member</h2>
                  {inviteError && <div className="alert alert-error">{inviteError}</div>}
                  {inviteSuccess && <div className="alert alert-success">{inviteSuccess}</div>}

                  <form onSubmit={handleInvite} style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div className="form-group" style={{ flex: 1, minWidth: '250px', marginBottom: 0 }}>
                      <label className="form-label" htmlFor="invEmail">Email Address</label>
                      <input
                        id="invEmail"
                        type="email"
                        placeholder="collaborator@domain.com"
                        className="form-control"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        required
                        disabled={inviteLoading}
                      />
                    </div>
                    <div className="form-group" style={{ minWidth: '150px', marginBottom: 0 }}>
                      <label className="form-label" htmlFor="invRole">Role</label>
                      <select
                        id="invRole"
                        className="form-control"
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as any)}
                        disabled={inviteLoading}
                        style={{ height: '43px', padding: '0.5rem 1rem' }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <button type="submit" className="btn btn-primary" style={{ height: '43px' }} disabled={inviteLoading}>
                      {inviteLoading ? 'Sending...' : 'Invite'}
                    </button>
                  </form>
                </div>
              )}

              {/* Members table */}
              <div className="card">
                <h2>Access Controls</h2>
                {authorizations.length === 0 ? (
                  <p style={{ margin: 0 }}>No additional team members. You are the sole administrator.</p>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Identity</th>
                          <th>Role</th>
                          <th>Status</th>
                          {isOwner && <th style={{ textAlign: 'right' }}>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {authorizations.map((auth) => (
                          <tr key={auth.id}>
                            <td style={{ verticalAlign: 'middle' }}>
                              {auth.status === 'active' ? (
                                <code style={{ fontSize: '0.85rem' }}>Profile: {auth.profile_id}</code>
                              ) : (
                                <span>{auth.invited_email}</span>
                              )}
                            </td>
                            <td style={{ verticalAlign: 'middle' }}>
                              <span className={`badge badge-${auth.role}`}>
                                {auth.role}
                              </span>
                            </td>
                            <td style={{ verticalAlign: 'middle' }}>
                              <span className={`badge badge-${auth.status}`}>
                                {auth.status}
                              </span>
                            </td>
                            {isOwner && (
                              <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                                <button
                                  onClick={() => handleRevoke(auth.id)}
                                  className="btn btn-danger"
                                  style={{ padding: '0.4rem 0.8rem', fontSize: '0.825rem' }}
                                >
                                  Revoke
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'groups' && isAdmin && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              <div className="card">
                <h2>Connect a Telegram Group</h2>
                {linkError && <div className="alert alert-error">{linkError}</div>}
                {linkSuccess && <div className="alert alert-success">{linkSuccess}</div>}
                
                <p style={{ margin: 0, fontSize: '0.95rem', color: 'var(--text-muted)' }}>
                  To link a Telegram group, generate a one-time link command below and execute it as a group administrator.
                </p>

                {!linkCode ? (
                  <button
                    onClick={handleGenerateCode}
                    className="btn btn-primary"
                    disabled={linkLoading}
                    style={{ marginTop: '1rem', alignSelf: 'flex-start' }}
                  >
                    {linkLoading ? 'Generating...' : 'Generate Link Command'}
                  </button>
                ) : (
                  <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div 
                      onClick={handleCopyCommand}
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        border: '1px dashed rgba(255, 255, 255, 0.15)',
                        borderRadius: '6px',
                        padding: '1.25rem',
                        cursor: 'pointer',
                        position: 'relative',
                        transition: 'background 0.2s',
                      }}
                      className="code-copy-box"
                    >
                      <div style={{ fontFamily: 'monospace', fontSize: '1.1rem', color: '#60a5fa' }}>
                        /auth {linkCode}
                      </div>
                      <span style={{
                        position: 'absolute',
                        right: '12px',
                        top: '12px',
                        fontSize: '0.8rem',
                        color: 'var(--text-muted)',
                      }}>
                        {copied ? 'Copied!' : 'Click to Copy'}
                      </span>
                    </div>
                    <p style={{ margin: 0, fontSize: '0.85rem' }}>
                      💡 <strong>Instructions:</strong> Click the box above to copy the command, go to your Telegram group, and paste it. 
                      This code is valid for 10 minutes and can only be used once. Only group administrators can run this command.
                    </p>
                    {timeLeft !== null && (
                      <div style={{ fontSize: '0.85rem', color: '#fbbf24' }}>
                        Expires in: {Math.floor(timeLeft / 60)}m {timeLeft % 60}s
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Linked Groups List */}
              <div className="card">
                <h2>Linked Telegram Groups</h2>
                {linkedGroups.length === 0 ? (
                  <p style={{ margin: 0 }}>No groups linked yet.</p>
                ) : (
                  <div className="table-container">
                    <table>
                      <thead>
                        <tr>
                          <th>Group Name</th>
                          <th>Telegram Chat ID</th>
                          <th>Linked Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {linkedGroups.map((g) => (
                          <tr key={g.id}>
                            <td><strong>{g.display_name}</strong></td>
                            <td><code>{g.telegram_chat_id}</code></td>
                            <td>{new Date(g.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
