import { AlertTriangle } from "lucide-react";
import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = {
			hasError: false,
			error: null,
		};
	}

	static getDerivedStateFromError(error: Error): State {
		return {
			hasError: true,
			error,
		};
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		if (import.meta.env.DEV) {
			console.error("Error caught by boundary:", error, errorInfo);
		}
	}

	handleReset = () => {
		this.setState({
			hasError: false,
			error: null,
		});
	};

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) {
				return this.props.fallback;
			}

			return (
				<div className="flex min-h-screen items-center justify-center p-6">
					<Card className="w-full max-w-md">
						<CardHeader className="text-center">
							<AlertTriangle className="mx-auto h-12 w-12 text-destructive mb-4" />
							<CardTitle>Something went wrong</CardTitle>
							<CardDescription>
								We encountered an unexpected error. Please try refreshing the
								page.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<Button onClick={this.handleReset} className="w-full">
								Try Again
							</Button>
							<Button
								variant="outline"
								onClick={() => window.location.reload()}
								className="w-full"
							>
								Refresh Page
							</Button>
						</CardContent>
					</Card>
				</div>
			);
		}

		return this.props.children;
	}
}
