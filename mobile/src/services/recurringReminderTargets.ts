export interface RecurringReminderTarget {
  id: string;
  description: string;
  dueDate: string;
}

export const recurringReminderTargetsFromResponse = (payload: any): RecurringReminderTarget[] => {
  const generated = payload?.generation?.generated;
  if (!Array.isArray(generated)) return [];

  return generated.flatMap((candidate: any) => {
    if (
      candidate?.is_recurring !== false
      || typeof candidate?.parent_bill_id !== 'string'
      || !candidate.parent_bill_id
      || typeof candidate?.id !== 'string'
      || !candidate.id
      || typeof candidate?.due_date !== 'string'
      || !candidate.due_date
    ) {
      return [];
    }

    return [{
      id: candidate.id,
      description: typeof candidate.description === 'string' ? candidate.description : '',
      dueDate: candidate.due_date,
    }];
  });
};
