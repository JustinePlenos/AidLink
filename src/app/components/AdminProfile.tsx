import { useEffect, useMemo, useState } from 'react';

export interface AdminProfileData {
  fullName: string;
  email: string;
  phone: string;
  role: string;
  avatarDataUrl?: string;
}

interface AdminProfileProps {
  profile: AdminProfileData;
  onSave: (next: AdminProfileData) => void;
  onBack: () => void;
}

export function AdminProfile({ profile, onSave, onBack }: AdminProfileProps) {
  const [draft, setDraft] = useState<AdminProfileData>(profile);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const initials = useMemo(() => {
    const parts = (draft.fullName || 'Admin').trim().split(/\s+/);
    return parts
      .slice(0, 2)
      .map((p) => p.charAt(0).toUpperCase())
      .join('');
  }, [draft.fullName]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setDraft((prev) => ({ ...prev, avatarDataUrl: String(reader.result || '') }));
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      onSave(draft);
      alert('Profile updated!');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-5xl" aria-labelledby="admin-profile-heading">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="admin-profile-heading" className="text-2xl text-gray-900">Admin Profile</h2>
          <p className="text-sm text-gray-600 mt-1">Manage your profile information and photo.</p>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="self-start px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors sm:self-auto"
        >
          Back
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-6 border-b border-gray-200 bg-slate-50">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full overflow-hidden bg-white border border-gray-200 flex items-center justify-center">
              {draft.avatarDataUrl ? (
                <img src={draft.avatarDataUrl} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                <span className="text-xl font-semibold text-blue-700">{initials}</span>
              )}
            </div>
            <div>
              <p className="text-lg font-medium text-gray-900">{draft.fullName || 'Admin User'}</p>
              <p className="text-sm text-gray-600">{draft.role || 'Case Worker'}</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label htmlFor="admin-profile-photo" className="block text-sm text-gray-700 mb-2">Profile Photo</label>
            <input
              id="admin-profile-photo"
              name="profilePhoto"
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-blue-600 file:text-white hover:file:bg-blue-700"
            />
            <p className="text-xs text-gray-500 mt-2">PNG/JPG recommended. The photo is saved locally in the browser.</p>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label htmlFor="admin-full-name" className="block text-sm text-gray-700 mb-2">Full Name</label>
              <input
                id="admin-full-name"
                name="fullName"
                type="text"
                value={draft.fullName}
                onChange={(e) => setDraft((p) => ({ ...p, fullName: e.target.value }))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter your full name"
                required
              />
            </div>

            <div>
              <label htmlFor="admin-role" className="block text-sm text-gray-700 mb-2">Role</label>
              <input
                id="admin-role"
                name="role"
                type="text"
                value={draft.role}
                readOnly
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-gray-600"
              />
              <p className="mt-1 text-xs text-gray-500">Roles are assigned through protected staff-account administration.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label htmlFor="admin-email" className="block text-sm text-gray-700 mb-2">Email</label>
              <input
                id="admin-email"
                name="email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft((p) => ({ ...p, email: e.target.value }))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="admin@example.com"
                required
              />
            </div>

            <div>
              <label htmlFor="admin-phone" className="block text-sm text-gray-700 mb-2">Phone</label>
              <input
                id="admin-phone"
                name="phone"
                type="tel"
                value={draft.phone}
                onChange={(e) => setDraft((p) => ({ ...p, phone: e.target.value }))}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Enter your contact number"
              />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => setDraft(profile)}
              className="px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 rounded-lg text-white bg-blue-700 hover:bg-blue-800 transition-colors disabled:opacity-60"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
