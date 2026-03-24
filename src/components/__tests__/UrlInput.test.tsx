import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UrlInput } from '../dashboard/UrlInput';

describe('UrlInput', () => {
  it('renders the input and buttons', () => {
    render(<UrlInput onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText(/Paste a video URL/i)).toBeTruthy();
    expect(screen.getByText('Paste')).toBeTruthy();
    expect(screen.getByText('Fetch')).toBeTruthy();
  });

  it('calls onSubmit when Fetch is clicked with a URL', () => {
    const onSubmit = vi.fn();
    render(<UrlInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/Paste a video URL/i);
    fireEvent.change(input, { target: { value: 'https://youtube.com/watch?v=test' } });
    fireEvent.click(screen.getByText('Fetch'));

    expect(onSubmit).toHaveBeenCalledWith('https://youtube.com/watch?v=test');
  });

  it('calls onSubmit on Enter key', () => {
    const onSubmit = vi.fn();
    render(<UrlInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/Paste a video URL/i);
    fireEvent.change(input, { target: { value: 'https://example.com/video' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith('https://example.com/video');
  });

  it('does not call onSubmit when input is empty', () => {
    const onSubmit = vi.fn();
    render(<UrlInput onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText('Fetch'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Fetch button is disabled when input is empty', () => {
    render(<UrlInput onSubmit={vi.fn()} />);
    const fetchBtn = screen.getByText('Fetch');
    expect(fetchBtn).toBeDisabled();
  });

  it('shows loading state', () => {
    render(<UrlInput onSubmit={vi.fn()} isLoading />);
    expect(screen.getByText('Parsing…')).toBeTruthy();
  });

  it('shows error message', () => {
    render(<UrlInput onSubmit={vi.fn()} error="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('handles multi-URL paste by setting text without auto-submit', () => {
    const onSubmit = vi.fn();
    const onBatchSubmit = vi.fn();
    render(<UrlInput onSubmit={onSubmit} onBatchSubmit={onBatchSubmit} />);

    const input = screen.getByPlaceholderText(/Paste a video URL/i);
    // Simulate a clipboard paste event with multi-line URLs
    const pasteData = 'https://a.com/1\nhttps://b.com/2\nhttps://c.com/3';
    fireEvent.paste(input, {
      clipboardData: { getData: () => pasteData },
    });

    // Multi-URL paste should set the text but NOT auto-submit
    expect(onBatchSubmit).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
