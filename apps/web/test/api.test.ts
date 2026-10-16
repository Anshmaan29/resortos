import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiUrl, ApiError, PROPERTY_CONTEXT_KEY } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('reception connection errors', () => {
  it('does not claim a booking was unsaved when its response is lost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/reservations', { method: 'POST', body: {} })).rejects.toThrow(/refresh this record before trying again/);
    await expect(api('/reservations')).rejects.toThrow(/Check the internet connection/);
  });

  it('shows useful errors for an HTML gateway response, without exposing the gateway page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>gateway details</html>', { status: 502 })));
    await expect(api('/reservations', { method: 'POST', body: {} })).rejects.toThrow(/check whether your changes were saved/);
    await expect(api('/reservations')).rejects.toThrow(/temporarily unavailable/);
  });

  it('preserves cancellation and field validation rather than replacing them', async () => {
    const cancelled = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancelled));
    await expect(api('/reservations')).rejects.toBe(cancelled);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'VALIDATION', message: 'Check guest details', details: { fields: [{ path: 'email', message: 'Invalid email' }] } }), { status: 400 })));
    const error = await api('/reservations', { method: 'POST' }).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.fields).toEqual({ email: 'Invalid email' });
  });

  it('keeps a rejected recovery code on the recovery form', async () => {
    const location = { pathname: '/recover', href: '' };
    vi.stubGlobal('window', { location });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'That username and recovery code do not match.' }), { status: 401 })));
    await expect(api('/auth/recover', { method: 'POST', body: {} })).rejects.toThrow(/do not match/);
    expect(location.href).toBe('');
  });
});

describe('per-tab resort context',()=>{
  it('keeps the phone scanner usable when browser storage is blocked',async()=>{
    vi.stubGlobal('window',{sessionStorage:{getItem:()=>{throw new DOMException('Storage blocked','SecurityError');},removeItem:()=>{throw new DOMException('Storage blocked','SecurityError');}}});
    vi.stubGlobal('fetch',vi.fn().mockImplementation(()=>Promise.resolve(new Response('{}',{status:200}))));
    await expect(api('/capture/example')).resolves.toEqual({});
    await expect(api('/auth/login',{method:'POST',body:{}})).resolves.toEqual({});
    expect(apiUrl('/capture/example')).toBe('/api/v1/capture/example');
  });
  it('binds API requests and printable/download URLs to the selected resort',async()=>{
    const getItem=vi.fn().mockReturnValue('villa-id');
    vi.stubGlobal('window',{sessionStorage:{getItem}});
    const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status:200}));vi.stubGlobal('fetch',fetcher);
    await api('/villa/bookings',{method:'POST',body:{}});
    expect(getItem).toHaveBeenCalledWith(PROPERTY_CONTEXT_KEY);
    expect(fetcher.mock.calls[0][1].headers['x-resortos-property']).toBe('villa-id');
    expect(apiUrl('/invoices/abc/pdf')).toBe('/api/v1/invoices/abc/pdf?propertyContext=villa-id');
    expect(apiUrl('/exports/bookings.csv?from=2026-10-17')).toContain('&propertyContext=villa-id');
  });
  it('clears the old context when a new person logs in',async()=>{
    const removeItem=vi.fn();vi.stubGlobal('window',{sessionStorage:{getItem:()=> 'old-villa',removeItem}});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:200})));
    await api('/auth/login',{method:'POST',body:{}});expect(removeItem).toHaveBeenCalledWith(PROPERTY_CONTEXT_KEY);
  });
});
