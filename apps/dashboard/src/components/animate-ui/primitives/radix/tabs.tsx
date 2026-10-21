'use client';

import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import {
  motion,
  AnimatePresence,
  useReducedMotion,
  type HTMLMotionProps,
  type Transition,
} from 'motion/react';

import {
  Highlight,
  HighlightItem,
  type HighlightProps,
  type HighlightItemProps,
} from '@/components/animate-ui/primitives/effects/highlight';
import { getStrictContext } from '@/utils/get-strict-context';
import { controlSpring, panelTransition } from '@/utils/motion';
import { useControlledState } from '@/hooks/use-controlled-state';
import {
  AutoHeight,
  type AutoHeightProps,
} from '@/components/animate-ui/primitives/effects/auto-height';

type TabsContextType = {
  value: string | undefined;
  setValue: TabsProps['onValueChange'];
};

const [TabsProvider, useTabs] =
  getStrictContext<TabsContextType>('TabsContext');

type TabsProps = React.ComponentProps<typeof TabsPrimitive.Root>;

function Tabs(props: TabsProps) {
  const [value, setValue] = useControlledState({
    value: props.value,
    defaultValue: props.defaultValue,
    onChange: props.onValueChange,
  });

  return (
    <TabsProvider value={{ value, setValue }}>
      <TabsPrimitive.Root
        data-slot="tabs"
        {...props}
        value={value}
        onValueChange={setValue}
      />
    </TabsProvider>
  );
}

type TabsHighlightProps = Omit<HighlightProps, 'controlledItems' | 'value'>;

function TabsHighlight({
  transition = controlSpring,
  ...props
}: TabsHighlightProps) {
  const { value } = useTabs();
  const reduce = useReducedMotion();

  return (
    <Highlight
      data-slot="tabs-highlight"
      controlledItems
      value={value}
      transition={reduce ? { duration: 0 } : transition}
      click={false}
      {...props}
    />
  );
}

type TabsListProps = React.ComponentProps<typeof TabsPrimitive.List>;

function TabsList(props: TabsListProps) {
  return <TabsPrimitive.List data-slot="tabs-list" {...props} />;
}

type TabsHighlightItemProps = HighlightItemProps & {
  value: string;
};

function TabsHighlightItem(props: TabsHighlightItemProps) {
  return <HighlightItem data-slot="tabs-highlight-item" {...props} />;
}

type TabsTriggerProps = React.ComponentProps<typeof TabsPrimitive.Trigger>;

function TabsTrigger(props: TabsTriggerProps) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" {...props} />;
}

type TabsContentProps = React.ComponentProps<typeof TabsPrimitive.Content> &
  HTMLMotionProps<'div'>;

function TabsContent({
  value,
  forceMount,
  transition = panelTransition,
  ...props
}: TabsContentProps) {
  const { value: activeValue } = useTabs();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {(forceMount || activeValue === value) && <TabsPrimitive.Content key={value} asChild forceMount value={value}>
        <motion.div
          data-slot="tabs-content"
          aria-hidden={activeValue !== value || undefined}
          inert={activeValue !== value || undefined}
          initial={{ opacity: 0, y: reduce ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.1 } }}
          transition={reduce ? { duration: 0 } : transition}
          {...props}
        />
      </TabsPrimitive.Content>}
    </AnimatePresence>
  );
}

type TabsContentsAutoProps = AutoHeightProps & {
  mode?: 'auto-height';
  children: React.ReactNode;
  transition?: Transition;
};

type TabsContentsLayoutProps = Omit<HTMLMotionProps<'div'>, 'transition'> & {
  mode: 'layout';
  children: React.ReactNode;
  transition?: Transition;
};

type TabsContentsProps = TabsContentsAutoProps | TabsContentsLayoutProps;

const defaultTransition: Transition = {
  type: 'spring',
  stiffness: 200,
  damping: 30,
};

function isAutoMode(props: TabsContentsProps): props is TabsContentsAutoProps {
  return !('mode' in props) || props.mode === 'auto-height';
}

function TabsContents(props: TabsContentsProps) {
  const { value } = useTabs();

  if (isAutoMode(props)) {
    const { transition = defaultTransition, ...autoProps } = props;

    return (
      <AutoHeight
        data-slot="tabs-contents"
        deps={[value]}
        transition={transition}
        {...autoProps}
      />
    );
  }

  const { transition = defaultTransition, style, ...layoutProps } = props;

  return (
    <motion.div
      data-slot="tabs-contents"
      layout="size"
      layoutDependency={value}
      style={{ overflow: 'hidden', ...style }}
      transition={{ layout: transition }}
      {...layoutProps}
    />
  );
}

export {
  Tabs,
  TabsHighlight,
  TabsHighlightItem,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsContents,
  type TabsProps,
  type TabsHighlightProps,
  type TabsHighlightItemProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsContentProps,
  type TabsContentsProps,
};
