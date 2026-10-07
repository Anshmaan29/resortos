'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Card, CardHeader, EmptyState, ErrorBanner, Skeleton } from '@/components/ui/surface';
import { Pill } from '@/components/ui/status';
import { useToast } from '@/components/ui/toast';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useInvalidateExpenses } from './expense-dialogs';
import type { ExpenseCategory } from './expenses-shared';

/** The owner's list behind "Category" when money is recorded out (spec §39). */
export function CategoryManagerCard() {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<ExpenseCategory | 'new' | null>(null);
  const categories = useQuery({
    queryKey: ['expense-categories', 'all'],
    queryFn: () => api<ExpenseCategory[]>('/expense-categories', { query: { includeInactive: 'true' } }),
  });

  return (
    <Card>
      <CardHeader
        title="Expense categories"
        description="What the desk picks from when money is recorded out. Turning one off hides it from new expenses."
        action={
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => setEdit('new')}><Plus className="h-4 w-4" aria-hidden />Add category</Button>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={open ? 'Hide categories' : 'Show categories'}
              className="flex h-9 w-9 items-center justify-center rounded-md text-text-3 hover:bg-surface-2 hover:text-text"
            >
              <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          </div>
        }
      />
      {open && (
        categories.isLoading ? <Skeleton className="m-4 h-24" /> : categories.isError ? (
          <div className="p-4"><ErrorBanner message={(categories.error as Error).message} onRetry={() => categories.refetch()} /></div>
        ) : (categories.data ?? []).length === 0 ? (
          <EmptyState icon={<Plus className="h-5 w-5" />} title="No categories yet" description="Add the ones the resort spends on — rent, salaries, supplies." />
        ) : (
          <div className="border-t border-border">
            {categories.data!.map((c) => (
              <div key={c.id} className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3 text-sm last:border-0', !c.isActive && 'opacity-60')}>
                <span className="min-w-0">
                  <span className="font-medium">{c.name}</span>
                  {!c.isActive && <span className="ml-2"><Pill>Off</Pill></span>}
                  <span className="block text-xs text-text-3">
                    {c.used === 0 ? 'Not used yet' : `Used in ${c.used} expense${c.used === 1 ? '' : 's'}`} · order {c.sortOrder}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>Edit</Button>
              </div>
            ))}
          </div>
        )
      )}
      {edit && <CategoryDialog category={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function CategoryDialog({ category, onClose }: { category: ExpenseCategory | null; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateExpenses();
  const [name, setName] = useState(category?.name ?? '');
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 0));
  const [isActive, setIsActive] = useState(category?.isActive ?? true);
  const orderOk = /^\d{1,3}$/.test(sortOrder);

  const save = useMutation({
    mutationFn: () =>
      category
        ? api(`/expense-categories/${category.id}`, {
            method: 'PATCH',
            body: { name: name.trim(), isActive, sortOrder: Number(sortOrder || '0'), version: category.version },
          })
        : api('/expense-categories', { method: 'POST', body: { name: name.trim(), isActive: true, sortOrder: Number(sortOrder || '0') } }),
    onSuccess: () => {
      invalidate();
      toast('success', 'Category saved');
      onClose();
    },
  });
  const fields = save.error instanceof ApiError ? save.error.fields : {};

  return (
    <Dialog
      open
      onClose={onClose}
      title={category ? `Edit ${category.name}` : 'Add a category'}
      description={category ? 'Old entries keep the category they were recorded with.' : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} disabled={!name.trim() || !orderOk} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {save.error && <ErrorBanner message={(save.error as Error).message} />}
        <Field label="Name" required error={fields.name}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Kitchen supplies" />}
        </Field>
        <Field label="Sort order" required error={fields.sortOrder} hint="Lower shows first in the desk's list">
          {(id) => <Input id={id} inputMode="numeric" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} className="num w-32" />}
        </Field>
        {category && (
          <label className="flex cursor-pointer items-start justify-between gap-4 pt-1 text-sm">
            <span>
              <span className="block font-medium">On the desk&apos;s list</span>
              <span className="block text-xs text-text-3">Off hides it from new expenses. Old entries keep their category.</span>
            </span>
            <input type="checkbox" className="mt-1 h-5 w-5 accent-brand" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          </label>
        )}
      </div>
    </Dialog>
  );
}
