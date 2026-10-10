import { useState } from 'react';
import {
  ActionBar,
  BottomNav,
  Button,
  Card,
  EmptyState,
  ErrorState,
  List,
  Money,
  Page,
  PaymentChip,
  Row,
  Section,
  Sheet,
  StatusChip,
  Stepper,
} from '@compass/ui/kit';

/**
 * Every kit component on one page, with the kind of content the real
 * screens carry: long Russian product names, six-figure amounts, both
 * payment methods. Development only (`/?kit`); main.tsx never loads it
 * in a production build.
 *
 * It is what tests/e2e/tests/kit.spec.ts measures DESIGN.md against, and
 * what a reviewer screenshots. It is not a mock-up of any screen.
 */
type Tab = 'order' | 'run' | 'confirm' | 'history';

const LINES: Array<{ name: string; detail: string; amount: string; method: 'cash' | 'transfer' }> =
  [
    { name: 'Помидоры', detail: '12 kg · 2 stores', amount: '114,000', method: 'cash' },
    {
      name: 'Картофель молодой, мытый, сетка',
      detail: '40 kg · 3 stores',
      amount: '1,280,000',
      method: 'transfer',
    },
    { name: '牛肉', detail: '8.5 kg · 1 store', amount: '935,000', method: 'transfer' },
    { name: 'Piyoz', detail: '6 kg · 2 stores', amount: '24,000', method: 'cash' },
  ];

export function KitGallery() {
  const [qty, setQty] = useState(2);
  const [tab, setTab] = useState<Tab>('run');
  const [sheet, setSheet] = useState(false);
  const label = (m: 'cash' | 'transfer') => (m === 'cash' ? 'Cash' : 'Transfer');

  return (
    <div className="flex h-full flex-col">
      <Page
        actions={
          <ActionBar
            summary={
              <>
                <span className="text-body text-secondary">4 items</span>
                <Money amount="2,353,000" currency="UZS" size="lg" />
              </>
            }
          >
            <Button variant="primary" data-testid="kit-primary" onClick={() => setSheet(true)}>
              Finish buying
            </Button>
          </ActionBar>
        }
      >
        <h1 className="text-h1">Component kit</h1>

        <Section title="Rows" summary={<Money amount="2,353,000" currency="UZS" />}>
          <List>
            {LINES.map((l) => (
              <Row
                key={l.name}
                data-testid="kit-row"
                title={l.name}
                detail={l.detail}
                value={<Money amount={l.amount} />}
                valueNote={<PaymentChip method={l.method} label={label(l.method)} />}
                onPress={() => setSheet(true)}
              />
            ))}
            <Row
              data-testid="kit-row"
              title="Sabzi"
              value={<StatusChip tone="pending">No price yet</StatusChip>}
            />
          </List>
        </Section>

        <Section title="Quantity">
          <List>
            <Row
              title="Помидоры"
              detail="Last paid 9,500 / kg"
              value={
                <Stepper
                  data-testid="kit-stepper"
                  value={String(qty)}
                  unit="kg"
                  onDecrement={() => setQty((q) => Math.max(0, q - 0.5))}
                  onIncrement={() => setQty((q) => q + 0.5)}
                  canDecrement={qty > 0}
                  onValuePress={() => setSheet(true)}
                />
              }
            />
          </List>
        </Section>

        <Section title="Status and payment">
          <Card>
            <div className="flex flex-wrap gap-sm">
              <StatusChip>Draft</StatusChip>
              <StatusChip tone="pending">Waiting for approval</StatusChip>
              <StatusChip tone="done">Received</StatusChip>
              <StatusChip tone="problem">Short delivery</StatusChip>
              <PaymentChip method="cash" label="Cash" />
              <PaymentChip method="transfer" label="Transfer" />
            </div>
          </Card>
        </Section>

        <Section title="Buttons">
          <Button variant="secondary">Add an item</Button>
          <Button variant="ghost">Back</Button>
          <Button variant="danger">Cancel this run</Button>
          <Button variant="primary" disabled>
            Nothing to send yet
          </Button>
        </Section>

        <Section title="Nothing here">
          <Card>
            <EmptyState
              title="No orders waiting"
              hint="Orders appear here as soon as a store sends one."
              action={<Button variant="secondary">Place an order</Button>}
            />
          </Card>
        </Section>

        <Section title="Something failed">
          <Card>
            <ErrorState
              title="Couldn't load today's run"
              detail="The connection dropped. Nothing was lost."
              retryLabel="Try again"
              onRetry={() => undefined}
            />
          </Card>
        </Section>
      </Page>

      <BottomNav<Tab>
        label="Sections"
        active={tab}
        onSelect={setTab}
        items={[
          { key: 'order', label: 'Order' },
          { key: 'run', label: 'Buying', count: 3 },
          { key: 'confirm', label: 'Receive' },
          { key: 'history', label: 'History' },
        ]}
      />

      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Finish buying?"
        actions={
          <>
            <Button variant="primary" onClick={() => setSheet(false)}>
              Finish
            </Button>
            <Button variant="ghost" onClick={() => setSheet(false)}>
              Keep buying
            </Button>
          </>
        }
      >
        <p className="text-body text-secondary">
          Four items, 2,353,000 UZS. Stores will be asked to confirm what they receive.
        </p>
      </Sheet>
    </div>
  );
}
