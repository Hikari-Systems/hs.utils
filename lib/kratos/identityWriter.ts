import logging from '../logging';

const log = logging('kratos:identityWriter');

export type KratosIdentityWriterOpts = {
  // Kratos admin API base URL, e.g. http://kratos:4434
  kratosAdminUrl: string;
};

type KratosIdentity = {
  id: string;
  schema_id?: string;
  state?: string;
  traits?: Record<string, unknown>;
  metadata_public?: Record<string, unknown> | null;
};

// Small admin client for patching Kratos identities. Reads the existing
// metadata_public, merges the supplied patch into it, and PUTs the whole
// identity back via /admin/identities/{id}. Used for things like terms
// acceptance — we keep traits/state untouched and only mutate
// metadata_public.
//
// Why PUT instead of PATCH? Kratos supports PATCH but it expects JSON Patch
// semantics, which is awkward for a partial merge of nested objects. Doing
// a read-modify-write through PUT is simpler and safe for low-write fields
// like terms acceptance.
export const createKratosIdentityWriter = (opts: KratosIdentityWriterOpts) => {
  const adminUrl = opts.kratosAdminUrl.replace(/\/+$/, '');
  if (!adminUrl) {
    throw new Error('createKratosIdentityWriter: kratosAdminUrl is required');
  }

  const getIdentity = async (id: string): Promise<KratosIdentity> => {
    const r = await fetch(
      `${adminUrl}/admin/identities/${encodeURIComponent(id)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(
        `Kratos getIdentity ${id} → ${r.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await r.json()) as KratosIdentity;
  };

  const putIdentity = async (
    id: string,
    body: {
      schema_id?: string;
      state?: string;
      traits?: Record<string, unknown>;
      metadata_public?: Record<string, unknown> | null;
    },
  ): Promise<void> => {
    const r = await fetch(
      `${adminUrl}/admin/identities/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(
        `Kratos putIdentity ${id} → ${r.status}: ${text.slice(0, 200)}`,
      );
    }
  };

  return {
    // Read-modify-write metadata_public for the given identity. The patch is
    // merged shallowly on top of the existing metadata_public; pass `null`
    // for a key in the patch to clear it.
    updateMetadataPublic: async (
      sub: string,
      patch: Record<string, unknown>,
    ): Promise<void> => {
      const identity = await getIdentity(sub);
      const merged: Record<string, unknown> = {
        ...(identity.metadata_public ?? {}),
        ...patch,
      };
      await putIdentity(sub, {
        schema_id: identity.schema_id,
        state: identity.state,
        traits: identity.traits ?? {},
        metadata_public: merged,
      });
      log.debug(
        `Updated metadata_public for identity=${sub}: keys=${Object.keys(patch).join(',')}`,
      );
    },
  };
};

export type KratosIdentityWriter = ReturnType<
  typeof createKratosIdentityWriter
>;
